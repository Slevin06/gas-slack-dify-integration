// スクリプトプロパティに保存されているキー名
const DIFY_API_KEY_PROPERTY = 'DIFY_API_KEY';
// const SLACK_VERIFICATION_TOKEN_PROPERTY = 'SLACK_VERIFICATION_TOKEN';

// CacheServiceを取得（スクリプト全体で共有）
const PROCESSED_EVENTS_CACHE = CacheService.getScriptCache();
// キャッシュの有効期限（秒）。Slackのリトライ間隔を考慮して設定。例: 60秒
const CACHE_EXPIRATION_SECONDS = 60; 

function doPost(e) {
  try {
    const slackData = JSON.parse(e.postData.contents);

    if (slackData.type === 'url_verification') {
      return ContentService
        .createTextOutput(slackData.challenge)
        .setMimeType(ContentService.MimeType.TEXT);
    }

    if (slackData.event) {
      // Slackイベントから一意のIDを特定する
      // Slackのイベントペイロードによって 'event_id', 'client_msg_id', または 'ts' (タイムスタンプ) などが利用可能
      // ここでは event.ts を使う例。より確実な一意性を求めるなら event.event_id があればそれを使う。
      // ドキュメントでSlackイベントの構造を確認し、適切なIDを選択してください。
      const eventIdentifier = slackData.event.ts; // 例としてタイムスタンプを使用

      if (eventIdentifier) {
        const cacheKey = 'slack_event_' + eventIdentifier;
        if (PROCESSED_EVENTS_CACHE.get(cacheKey)) {
          console.log(`Event with ID ${eventIdentifier} already processed or currently processing. Skipping.`);
          // すでに処理中または処理済みの場合は、OKを返して終了
          return ContentService.createTextOutput('OK - Already processed').setMimeType(ContentService.MimeType.TEXT);
        }
        // キャッシュにイベントIDを保存（有効期限付き）
        PROCESSED_EVENTS_CACHE.put(cacheKey, 'true', CACHE_EXPIRATION_SECONDS);
      } else {
        console.warn('Could not determine a unique event identifier. Duplicate processing might occur.');
      }

      console.log('Received Slack event:', JSON.stringify(slackData.event, null, 2));
      callDifyWorkflow(slackData.event);
    }
    
    return ContentService
      .createTextOutput('OK')
      .setMimeType(ContentService.MimeType.TEXT);
      
  } catch (error) {
    console.error('Error in doPost:', error, '\nRaw postData:', e.postData ? e.postData.contents : 'No postData');
    return ContentService
      .createTextOutput('Error processing request: ' + error.message)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function callDifyWorkflow(slackEvent) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const DIFY_API_KEY = scriptProperties.getProperty(DIFY_API_KEY_PROPERTY);

  if (!DIFY_API_KEY) {
    console.error('Dify API Key is not set in script properties. Please configure it in Project Settings > Script Properties.');
    return;
  }
  
  const DIFY_ENDPOINT = 'https://api.dify.ai/v1/workflows/run'; 
  
  const payload = {
    inputs: {
      slack_text: slackEvent.text || '',
      channel_id: slackEvent.channel || '',
      timestamp: slackEvent.ts || '',
      user_id: slackEvent.user || '',
      event_type: slackEvent.type || ''
      // その他、Difyワークフローで利用したい情報があれば追加
    },
    response_mode: "streaming", // "blocking" から "streaming" に変更
    user: "gas-slack-trigger"
  };
  
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DIFY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true 
  };
  
  try {
    console.log('Sending request to Dify (streaming):', DIFY_ENDPOINT, '\nPayload:', JSON.stringify(payload, null, 2));
    // "streaming" モードの場合、このfetchはDifyがリクエストを受け付けた時点で比較的すぐに返ってくる
    const response = UrlFetchApp.fetch(DIFY_ENDPOINT, options);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();
    
    console.log(`Dify API (streaming) Response Code: ${responseCode}`);
    console.log(`Dify API (streaming) Response Body: ${responseBody}`); // streamingの場合、bodyはワークフローの最終結果ではないことが多い
    
    if (responseCode >= 400) {
      console.error(`Error calling Dify API (streaming). Status: ${responseCode}. Response: ${responseBody}`);
      // TODO: 必要に応じてエラーを管理者に通知するなどの処理を追加
    } else {
      // Dify API呼び出し成功（ワークフロー開始成功）
      console.log('Successfully initiated Dify workflow (streaming).');
    }
    
  } catch (error) {
    console.error('Failed to call Dify API (UrlFetchApp error):', error);
  }
}