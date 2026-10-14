import { createClient } from '@supabase/supabase-js';

// Account Mapping
const accountMap = {
  sib: 'SIB',
  liquid: 'Cash',
  sbi: 'SBI'
};
const DEFAULT_ACCOUNT = 'SIB';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS for frontend requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // In production, replace '*' with your Pages URL
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    // 2. New AI Analysis Endpoint
    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      try {
        const { expenses } = await request.json();
        
        // Strict prompt engineering to force a JSON-only response
        const prompt = `You are a financial categorizer. Read the following expenses. Group them into 4 broad categories (e.g., Food & Dining, Transport, Utilities, Misc). Sum the amounts for each category. Output ONLY a valid JSON object where keys are category names and values are the total numbers. Do not include markdown, code blocks, or any other text. Example: {"Food": 150, "Transport": 20}. Expenses: ${JSON.stringify(expenses)}`;

        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [{ role: 'user', content: prompt }]
        });

        return new Response(JSON.stringify({ analysis: aiResponse.response }), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200 
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
          headers: corsHeaders, 
          status: 500 
        });
      }
    }

    // 3. Existing Telegram Webhook Logic...
    if (request.method !== 'POST') {
      return new Response('Expense Bot is running!', { status: 200 });
    }

    try {
      const update = await request.json();
      
      const msg = update.message || update.edited_message;
      if (!msg || !msg.text) {
        return new Response('OK', { status: 200 });
      }

      const isEdit = !!update.edited_message;
      const chatId = msg.chat.id;
      const messageId = msg.message_id; 
      const text = msg.text.trim();
      const command = text.toLowerCase();
      const username = msg.from.username || msg.from.first_name || 'Anonymous';

      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

      // --- COMMAND HANDLING ---
	  if (command === '/start') {
        const welcomeMessage = `👋 *Welcome to your Expense Tracker!*
        
I'm ready to log your expenses.

📖 *How to log an expense:*
*Format:* \`[account] <item> <amount>\`
*Default Account:* ${DEFAULT_ACCOUNT}

*Examples:*
• \`sib petrol 500\` -> logs 500 to SIB
• \`petrol 500\` -> logs 500 to SIB
• \`500 petrol\` -> logs 500 to SIB
• \`liquid 50 chocolates 100\` -> logs 100 to Cash
• \`remove petrol 500\` -> Deletes the latest match

*Commands:*
/expensetoday - Today's summary
/expensethismonth - This month's summary
/status - Check bot connection
/format - Show this formatting guide`;
        
        await sendTelegramMessage(chatId, welcomeMessage, env.TELEGRAM_TOKEN);
        return new Response('OK', { status: 200 });
      }

      if (command === '/status') {
        await sendTelegramMessage(chatId, "✅ *Bot is online!*\nReady to track expenses.", env.TELEGRAM_TOKEN);
        return new Response('OK', { status: 200 });
      }

      if (command === '/expensetoday') {
        await handleExpenseSummary(chatId, supabase, env.TELEGRAM_TOKEN, 'today');
        return new Response('OK', { status: 200 });
      }

      if (command === '/expensethismonth') {
        await handleExpenseSummary(chatId, supabase, env.TELEGRAM_TOKEN, 'month');
        return new Response('OK', { status: 200 });
      }

      if (command === '/format') {
        const formatGuide = `📖 *Expense Bot Formats*
        
*Standard:* \`[account] <item> <amount>\`
*Default Account:* ${DEFAULT_ACCOUNT}

*Examples:*
• \`sib petrol 500\` -> logs 500 to SIB
• \`petrol 500\` -> logs 500 to SIB
• \`500 petrol\` -> logs 500 to SIB
• \`liquid 50 chocolates 100\` -> logs 100 to Cash
• \`remove petrol 500\` -> Deletes the latest match`;
        
        await sendTelegramMessage(chatId, formatGuide, env.TELEGRAM_TOKEN);
        return new Response('OK', { status: 200 });
      }

      // --- EXPENSE PARSING ---
      let parts = text.split(/\s+/);
      let isRemove = false;

      if (parts[0].toLowerCase() === 'remove') {
        isRemove = true;
        parts.shift(); 
      }

      if (parts.length < 2) {
        if (!isRemove && !isEdit) {
          await sendTelegramMessage(chatId, "⚠️ Invalid format. Send /format for help.", env.TELEGRAM_TOKEN);
        }
        return new Response('OK', { status: 200 });
      }

      let account = DEFAULT_ACCOUNT;
      const firstWord = parts[0].toLowerCase();
      if (accountMap[firstWord]) {
        account = accountMap[firstWord];
        parts.shift();
      }

      if (parts.length < 2) {
         await sendTelegramMessage(chatId, "⚠️ Please provide both a category and an amount.", env.TELEGRAM_TOKEN);
         return new Response('OK', { status: 200 });
      }

      let amount, category;
      const lastPart = parts[parts.length - 1];
      const firstRemainingPart = parts[0];
      
      const hasDigits = (str) => /\d/.test(str);
      const extractNumber = (str) => parseFloat(str.replace(/[^\d.]/g, ''));

      if (hasDigits(lastPart) && !isNaN(extractNumber(lastPart))) {
        amount = extractNumber(lastPart);
        parts.pop();
        category = parts.join(' ');
      } else if (hasDigits(firstRemainingPart) && !isNaN(extractNumber(firstRemainingPart))) {
        amount = extractNumber(firstRemainingPart);
        parts.shift();
        category = parts.join(' ');
      } else {
        await sendTelegramMessage(chatId, "⚠️ Couldn't find a valid amount.", env.TELEGRAM_TOKEN);
        return new Response('OK', { status: 200 });
      }

      // --- DATABASE OPERATIONS ---
      if (isRemove) {
        const { data } = await supabase
          .from('expenses')
          .select('id')
          .eq('account', account)
          .eq('category', category)
          .eq('amount', amount)
          .order('created_at', { ascending: false })
          .limit(1);

        if (data && data.length > 0) {
          await supabase.from('expenses').delete().eq('id', data[0].id);
          await sendTelegramMessage(chatId, "done", env.TELEGRAM_TOKEN);
        } else {
          await sendTelegramMessage(chatId, "⚠️ Could not find a matching past entry to remove.", env.TELEGRAM_TOKEN);
        }
      } 
      else if (isEdit) {
        const { error } = await supabase
          .from('expenses')
          .update({ account, category, amount })
          .eq('message_id', messageId);

        if (!error) {
          await sendTelegramMessage(chatId, `edited item rs${amount}`, env.TELEGRAM_TOKEN);
        }
      } 
      else {
        // Standard Insert returning the new ID
        const { data: insertedRow, error } = await supabase
          .from('expenses')
          .insert([{ username, account, category, amount, message_id: messageId }])
          .select('id')
          .single();

        if (error) throw error;

        // Wait 1.5 seconds to see if more webhooks fire from an offline burst
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Check if any newer row was inserted by this user while we were waiting
        const { data: newerRows } = await supabase
          .from('expenses')
          .select('id')
          .eq('username', username)
          .gt('id', insertedRow.id)
          .limit(1);

        // Only send "done" if this is the absolute latest message 
        if (!newerRows || newerRows.length === 0) {
          await sendTelegramMessage(chatId, "done", env.TELEGRAM_TOKEN);
        }
      }

    } catch (err) {
      console.error('Worker Error:', err.message);
    }

    return new Response('OK', { status: 200 });
  },
};

// --- HELPERS ---

async function sendTelegramMessage(chatId, text, token) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' }),
  });
}

async function handleExpenseSummary(chatId, supabase, token, period) {
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  
  let startDateStr;
  let title;
  
  if (period === 'today') {
    startDateStr = `${year}-${month}-${day}T00:00:00+05:30`;
    title = "Today's Expenses";
  } else {
    startDateStr = `${year}-${month}-01T00:00:00+05:30`;
    title = "This Month's Expenses";
  }

  const { data, error } = await supabase
    .from('expenses')
    .select('account, amount')
    .gte('created_at', startDateStr);

  if (error || !data || data.length === 0) {
    await sendTelegramMessage(chatId, `No expenses recorded for ${period}.`, token);
    return;
  }

  let grandTotal = 0;
  const accountTotals = {};

  data.forEach((row) => {
    const amt = Number(row.amount);
    grandTotal += amt;
    accountTotals[row.account] = (accountTotals[row.account] || 0) + amt;
  });

  let message = `📊 *${title}*\n\n💰 *Total:* ₹${grandTotal.toFixed(2)}\n\n*By Account:*\n`;
  for (const [acc, amt] of Object.entries(accountTotals)) {
    message += `• ${acc}: ₹${amt.toFixed(2)}\n`;
  }

  await sendTelegramMessage(chatId, message, token);
}