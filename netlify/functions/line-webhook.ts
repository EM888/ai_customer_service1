import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { data: settings, error: settingsError } = await supabase.from('settings').select('*').single();
  if (settingsError || !settings) return { statusCode: 500, body: 'Failed to fetch settings' };

  const lineClient = new Client({
    channelAccessToken: settings.line_channel_access_token,
    channelSecret: settings.line_channel_secret,
  });

  const signature = event.headers['x-line-signature'] || '';
  if (!validateSignature(event.body || '', settings.line_channel_secret, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const events: WebhookEvent[] = JSON.parse(event.body || '').events;

  for (const lineEvent of events) {
    if (lineEvent.type === 'message' && lineEvent.message.type === 'text') {
      const userId = lineEvent.source.userId!;
      const userMessage = (lineEvent.message.text || '').trim();
      const eventId = (lineEvent as any).webhookEventId;

      if (!userMessage || !eventId) continue;

      // 1. 強制去重 (關鍵防禦)
      // 嘗試寫入 event_id，如果重複，資料庫會報錯
      const { error: eventError } = await supabase
        .from('processed_events')
        .insert({ event_id: eventId });

      if (eventError) {
        console.log(`[Dedupe] Skipping already processed event: ${eventId}`);
        continue; // 這是重複請求，直接跳過，不進行任何狀態更新
      }

      // 2. 獲取當前狀態
      const { data: userState } = await supabase.from('user_states').select('*').eq('line_user_id', userId).single();
      
      // 3. 關鍵字偵測
      const handoverKeywords = settings.handover_keywords
        ?.replace(/，/g, ',')
        .split(',')
        .map((k: string) => k.trim())
        .filter((k: string) => k.length > 0) || [];
      
      const matchedKeyword = handoverKeywords.find((k: string) => {
        if (k.length === 1) return userMessage === k; 
        return userMessage.includes(k);
      });

      if (matchedKeyword) {
        console.log(`[Handover] Triggered by keyword: ${matchedKeyword}`);
        let nickname = userState?.nickname || '匿名用戶';
        try { const p = await lineClient.getProfile(userId); nickname = p.displayName; } catch (e) {}
        
        await supabase.from('user_states').upsert({
          line_user_id: userId, 
          nickname,
          is_human_mode: true, 
          last_human_interaction: new Date().toISOString()
        });

        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: '已為您轉接真人客服，請稍候。' });
        
        const agentIds = settings.agent_user_ids?.split(',').map((id: string) => id.trim()).filter(Boolean);
        if (agentIds) {
          for (const id of agentIds) {
            try { await lineClient.pushMessage(id, { type: 'text', text: `🔔 真人通知：【${nickname}】正在呼叫專人。\n觸發字：${matchedKeyword}\n原文：${userMessage}` }); } catch (e) {}
          }
        }
        continue;
      }

      // 4. 真人模式判斷
      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
        if (new Date().getTime() - lastInteraction < timeoutMs) continue; 
        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
      }

      // 5. 呼叫 AI
      if (!settings.is_ai_enabled) continue;

      let aiResult = '';
      try {
        if (settings.active_ai === 'gpt') aiResult = (await callGPT(settings, userMessage)).text;
        else aiResult = await callGemini(settings, userMessage);
      } catch (e: any) {
        aiResult = `❌ AI 錯誤：\n${e.message}`;
      }

      if (aiResult) {
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: aiResult });
      }
    }
  }
  return { statusCode: 200, body: 'OK' };
};

async function callDify(settings: any, currentMessage: string, userId: string) {
  // 從資料庫抓取 Dify 設定，如果沒有設定則報錯
  const apiKey = settings.dify_api_key;
  const apiUrl = settings.dify_api_url || 'https://api.dify.ai/v1';

  if (!apiKey) {
    throw new Error('請在後台設定 Dify API Key');
  }

  const response = await fetch(`${apiUrl}/chat-messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      "inputs": {}, 
      "query": currentMessage,
      "response_mode": "blocking",
      "user": userId 
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Dify API 呼叫失敗');
  }

  const result = await response.json();
  return result.answer || 'Dify 沒有回傳答案';
}
// --- 找到處理文字訊息的地方，替換成這段 ---
    if (event.type === 'message' && event.message.type === 'text') {
      const { text: userText } = event.message;
      const userId = event.source.userId;
      const replyToken = event.replyToken;

      try {
        // 直接呼叫 Dify (我們剛剛寫好的新工人)
        const aiResponse = await callDify(settings, userText, userId);

        // 透過 LINE 官方工具回傳給用戶
        await client.replyMessage(replyToken, {
          type: 'text',
          text: aiResponse
        });
      } catch (err) {
        console.error('Dify 呼叫失敗:', err);
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '抱歉，系統暫時無法回應，請稍後再試。'
        });
      }
    }
    // ---------------------------------------
