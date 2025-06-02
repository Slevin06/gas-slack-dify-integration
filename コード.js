// 設定値を一箇所で管理
const CONFIG = {
    DIFY_API_KEY_PROPERTY: 'DIFY_API_KEY',
    SLACK_SIGNING_SECRET_PROPERTY: 'SLACK_SIGNING_SECRET',
    SLACK_VERIFICATION_TOKEN_PROPERTY: 'SLACK_VERIFICATION_TOKEN',
    DIFY_ENDPOINT: 'https://api.dify.ai/v1/workflows/run',
    CACHE_EXPIRATION_SECONDS: 60,
    DEBUG_MODE_PROPERTY: 'DEBUG_MODE',
    SKIP_SIGNATURE_VERIFICATION_PROPERTY: 'SKIP_SIGNATURE_VERIFICATION', // 一時的なデバッグ用
    REQUEST_TIMESTAMP_TOLERANCE: 300 // 5分
};

/*
 * 本格運用時の推奨設定:
 * 
 * Google Apps Scriptのプロジェクト設定 > スクリプトプロパティ:
 * 
 * 【必須設定】
 * 1. DIFY_API_KEY: 'your_dify_api_key'
 * 2. SLACK_VERIFICATION_TOKEN: 'Exal5wfJRT6Qwc3r1uueId3M' (Slackアプリの設定から取得)
 * 
 * 【本格運用時】
 * 3. DEBUG_MODE: 削除または'false' (ログ量を削減)
 * 4. SKIP_SIGNATURE_VERIFICATION: 削除または'false' (認証を有効化)
 * 
 * 【開発・デバッグ時】
 * 3. DEBUG_MODE: 'true' (詳細ログを出力)
 * 4. SKIP_SIGNATURE_VERIFICATION: 'true' (認証をスキップ)
 * 
 * 【技術的制約】
 * - Google Apps ScriptではSlackの署名検証用HTTPヘッダーが取得できません
 * - そのため、トークン認証を使用します（セキュリティ上問題ありません）
 * - 署名検証は自動的に失敗し、トークン認証にフォールバックします
 */

// CacheServiceを取得（スクリプト全体で共有）
const PROCESSED_EVENTS_CACHE = CacheService.getScriptCache();

/**
 * Slackリクエストの署名を検証する
 * 注意: Google Apps ScriptではHTTPヘッダーの取得に制限があるため、
 * 署名検証は通常失敗し、トークン認証にフォールバックします。
 * @param {Object} e - doPostのイベントオブジェクト
 * @return {boolean} 検証結果
 */
function verifySlackRequest(e) {
    const scriptProperties = PropertiesService.getScriptProperties();
    const signingSecret = scriptProperties.getProperty(CONFIG.SLACK_SIGNING_SECRET_PROPERTY);

    if (!signingSecret) {
        console.error('Slack Signing Secret is not configured');
        return false;
    }

    // デバッグ情報を出力
    if (isDebugMode()) {
        console.log('Request object keys:', Object.keys(e));
        console.log('PostData object:', JSON.stringify(e.postData || {}, null, 2));
        console.log('Parameters:', JSON.stringify(e.parameter || {}, null, 2));
        console.log('Query string:', e.queryString || 'none');
    }

    // Google Apps Scriptでは、HTTPヘッダーは直接アクセスできない場合がある
    // セキュリティ上の理由から、クエリパラメータでの署名取得は行わない
    let timestamp = null;
    let signature = null;

    // postDataのheadersから取得を試行（存在する場合のみ）
    if (e.postData && e.postData.headers) {
        const headers = e.postData.headers;
        timestamp = headers['X-Slack-Request-Timestamp'] || headers['x-slack-request-timestamp'];
        signature = headers['X-Slack-Signature'] || headers['x-slack-signature'];
    }

    const body = e.postData ? e.postData.contents : '';

    if (isDebugMode()) {
        console.log('Extracted timestamp:', timestamp);
        console.log('Extracted signature:', signature);
        console.log('Body length:', body ? body.length : 0);
        console.log('Body preview:', body ? body.substring(0, 100) + '...' : 'empty');
    }

    if (!timestamp || !signature) {
        console.warn('Missing required Slack headers. This is expected due to Google Apps Script limitations.');

        // デバッグ用に利用可能なすべてのプロパティを出力
        if (isDebugMode()) {
            console.log('Available e properties:', Object.keys(e));
            if (e.postData) {
                console.log('Available postData properties:', Object.keys(e.postData));
                if (e.postData.headers) {
                    console.log('Available headers:', Object.keys(e.postData.headers));
                }
            }
        }

        // Google Apps Scriptの制限により、HTTPヘッダーが取得できない
        // この場合、トークン認証を使用する
        console.info('Falling back to token verification due to GAS header limitations.');
        return false;
    }

    // タイムスタンプチェック（リプレイ攻撃防止）
    const currentTime = Math.floor(Date.now() / 1000);
    const timestampInt = parseInt(timestamp, 10);
    if (isNaN(timestampInt)) {
        console.error('Invalid timestamp:', timestamp);
        return false;
    }

    if (Math.abs(currentTime - timestampInt) > CONFIG.REQUEST_TIMESTAMP_TOLERANCE) {
        console.error('Request timestamp is too old. Current:', currentTime, 'Request:', timestampInt);
        return false;
    }

    // 署名検証
    const baseString = `v0:${timestamp}:${body}`;
    const expectedSignature = 'v0=' +
        Utilities.computeHmacSha256Signature(baseString, signingSecret)
            .map(byte => ('0' + (byte & 0xFF).toString(16)).slice(-2))
            .join('');

    if (isDebugMode()) {
        console.log('Base string for signature:', baseString);
        console.log('Expected signature:', expectedSignature);
        console.log('Received signature:', signature);
        console.log('Signatures match:', signature === expectedSignature);
    }

    const isValid = Utilities.timingSafeEqual(
        Utilities.newBlob(signature).getBytes(),
        Utilities.newBlob(expectedSignature).getBytes()
    );

    if (!isValid) {
        console.error('Signature verification failed');
    }

    return isValid;
}

/**
 * より確実な一意識別子を取得する
 * @param {Object} slackData - Slackイベントデータ
 * @return {string|null} イベント識別子
 */
function getEventIdentifier(slackData) {
    // 1. event_idが最も確実（グローバルに一意）
    if (slackData.event_id) {
        return slackData.event_id;
    }

    // 2. client_msg_idがある場合（メッセージイベント）
    if (slackData.event && slackData.event.client_msg_id) {
        return slackData.event.client_msg_id;
    }

    // 3. フォールバック: チャンネル+タイムスタンプの組み合わせ
    if (slackData.event && slackData.event.ts && slackData.event.channel) {
        return `${slackData.event.channel}_${slackData.event.ts}`;
    }

    // 4. 最終フォールバック: タイムスタンプのみ
    return slackData.event ? slackData.event.ts : null;
}

/**
 * 重複イベントをチェックし、キャッシュに保存する
 * @param {string} eventIdentifier - イベント識別子
 * @return {boolean} 重複している場合はtrue
 */
function isDuplicateEvent(eventIdentifier) {
    if (!eventIdentifier) return false;

    const cacheKey = 'slack_event_' + eventIdentifier;
    if (PROCESSED_EVENTS_CACHE.get(cacheKey)) {
        return true;
    }

    PROCESSED_EVENTS_CACHE.put(cacheKey, 'true', CONFIG.CACHE_EXPIRATION_SECONDS);
    return false;
}

/**
 * 署名検証をスキップするかどうかを判定する（デバッグ用）
 * @return {boolean} スキップする場合はtrue
 */
function shouldSkipSignatureVerification() {
    const scriptProperties = PropertiesService.getScriptProperties();
    return scriptProperties.getProperty(CONFIG.SKIP_SIGNATURE_VERIFICATION_PROPERTY) === 'true';
}

/**
 * デバッグモードかどうかを判定する
 * @return {boolean} デバッグモードの場合はtrue
 */
function isDebugMode() {
    const scriptProperties = PropertiesService.getScriptProperties();
    return scriptProperties.getProperty(CONFIG.DEBUG_MODE_PROPERTY) === 'true';
}

/**
 * イベントログを出力する
 * @param {Object} slackEvent - Slackイベント
 */
function logSlackEvent(slackEvent) {
    if (isDebugMode()) {
        console.log('Received Slack event:', JSON.stringify(slackEvent, null, 2));
    } else {
        console.log(`Received Slack event: ${slackEvent.type || 'unknown'} from channel ${slackEvent.channel || 'unknown'}`);
    }
}

/**
 * Slackトークンによる認証を行う（署名検証の代替手段）
 * @param {Object} slackData - パースされたSlackデータ
 * @return {boolean} 認証結果
 */
function verifySlackToken(slackData) {
    const scriptProperties = PropertiesService.getScriptProperties();
    const expectedToken = scriptProperties.getProperty(CONFIG.SLACK_VERIFICATION_TOKEN_PROPERTY);

    if (!expectedToken) {
        console.warn('Slack verification token is not configured');
        return false;
    }

    const receivedToken = slackData.token;
    const isValid = receivedToken === expectedToken;

    if (isDebugMode()) {
        console.log('Token verification - Expected:', expectedToken ? 'configured' : 'not configured');
        console.log('Token verification - Received:', receivedToken ? 'present' : 'missing');
        console.log('Token verification - Valid:', isValid);
    }

    return isValid;
}

/**
 * 複合認証：署名検証またはトークン認証
 * 実際の運用では、GASの制限により署名検証は失敗し、トークン認証が使用されます。
 * @param {Object} e - doPostのイベントオブジェクト
 * @param {Object} slackData - パースされたSlackデータ
 * @return {boolean} 認証結果
 */
function authenticateSlackRequest(e, slackData) {
    // 署名検証をスキップする設定の場合
    if (shouldSkipSignatureVerification()) {
        if (isDebugMode()) {
            console.log('Signature verification skipped (debug mode)');
        }
        return true;
    }

    // 1. 署名検証を試行（GASの制限により通常は失敗）
    const signatureValid = verifySlackRequest(e);
    if (signatureValid) {
        if (isDebugMode()) {
            console.log('Slack request authenticated via signature verification');
        }
        return true;
    }

    // 2. 署名検証が失敗した場合、トークン認証を試行（実際のメイン認証方式）
    if (isDebugMode()) {
        console.log('Signature verification failed, trying token verification...');
    }
    const tokenValid = verifySlackToken(slackData);
    if (tokenValid) {
        // 本格運用時でもトークン認証成功は重要な情報として出力
        console.log('Slack request authenticated via token verification');
        return true;
    }

    // 3. 両方とも失敗
    console.error('Both signature and token verification failed');
    return false;
}

/**
 * doPost関数はSlackからのPOSTリクエストを処理します
 * @param e
 * @returns {*}
 */
function doPost(e) {
    try {
        // デバッグ情報を最初に出力
        if (isDebugMode()) {
            console.log('=== doPost called ===');
            console.log('Full request object:', JSON.stringify(e, null, 2));
        }

        const slackData = JSON.parse(e.postData.contents);

        if (isDebugMode()) {
            console.log('Parsed Slack data:', JSON.stringify(slackData, null, 2));
        }

        // URL verification は即座にレスポンス（署名検証不要）
        if (slackData.type === 'url_verification') {
            console.log('URL verification request received');
            return ContentService
                .createTextOutput(slackData.challenge)
                .setMimeType(ContentService.MimeType.TEXT);
        }

        // 通常のイベントの場合のみ認証チェック
        if (!authenticateSlackRequest(e, slackData)) {
            console.error('Slack request authentication failed');
            return ContentService
                .createTextOutput('Unauthorized')
                .setMimeType(ContentService.MimeType.TEXT);
        }

        if (slackData.event) {
            // 重複チェック
            const eventIdentifier = getEventIdentifier(slackData);
            if (eventIdentifier && isDuplicateEvent(eventIdentifier)) {
                console.log(`Duplicate event detected: ${eventIdentifier}`);
                return ContentService.createTextOutput('OK - Already processed')
                    .setMimeType(ContentService.MimeType.TEXT);
            }

            // イベントログ出力
            logSlackEvent(slackData.event);

            // 即座にOKレスポンスを返す
            const response = ContentService.createTextOutput('OK')
                .setMimeType(ContentService.MimeType.TEXT);

            // 非同期でDify APIを呼び出し（GASの制限内で）
            try {
                callDifyWorkflow(slackData.event);
            } catch (error) {
                console.error('Error calling Dify workflow:', error);
                // エラーでもSlackには成功レスポンスを返す
            }

            return response;
        }

        return ContentService
            .createTextOutput('OK')
            .setMimeType(ContentService.MimeType.TEXT);

    } catch (error) {
        console.error('Error in doPost:', error, '\nRaw postData:', e.postData ? e.postData.contents : 'No postData');
        return ContentService
            .createTextOutput('Error processing request')
            .setMimeType(ContentService.MimeType.TEXT);
    }
}

/**
 * Difyワークフローを呼び出す
 * @param slackEvent
 */
function callDifyWorkflow(slackEvent) {
    const scriptProperties = PropertiesService.getScriptProperties();
    const DIFY_API_KEY = scriptProperties.getProperty(CONFIG.DIFY_API_KEY_PROPERTY);

    if (!DIFY_API_KEY) {
        console.error('Dify API Key is not set in script properties. Please configure it in Project Settings > Script Properties.');
        return;
    }

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
        if (isDebugMode()) {
            console.log('Sending request to Dify (streaming):', CONFIG.DIFY_ENDPOINT, '\nPayload:', JSON.stringify(payload, null, 2));
        } else {
            console.log(`Sending request to Dify for event: ${slackEvent.type || 'unknown'}`);
        }

        // "streaming" モードの場合、このfetchはDifyがリクエストを受け付けた時点で比較的すぐに返ってくる
        const response = UrlFetchApp.fetch(CONFIG.DIFY_ENDPOINT, options);
        const responseCode = response.getResponseCode();
        const responseBody = response.getContentText();

        if (isDebugMode()) {
            console.log(`Dify API (streaming) Response Code: ${responseCode}`);
            console.log(`Dify API (streaming) Response Body: ${responseBody}`);
        } else {
            console.log(`Dify API response: ${responseCode}`);
        }

        if (responseCode >= 400) {
            console.error(`Error calling Dify API (streaming). Status: ${responseCode}. Response: ${responseBody}`);
        } else {
            // Dify API呼び出し成功（ワークフロー開始成功）
            console.log('Successfully initiated Dify workflow (streaming).');
        }

    } catch (error) {
        console.error('Failed to call Dify API (UrlFetchApp error):', error);
    }
}