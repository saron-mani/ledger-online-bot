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

    // 2. AI Analysis Endpoint
    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      try {
        const { expenses } = await request.json();
        
        // Dynamic AI Prompt: Instructs Llama to adaptively split or merge categories
        const prompt = `You are an intelligent financial categorizer. Analyze the following list of expenses and assign a short category name to each based on its 'id'. 
        
        Follow these rules to dynamically size the categories:
        - If there are many diverse items, merge similar ones into broad groups (e.g., group "movie", "spotify", and "game" into "Entertainment").
        - If the items are overwhelmingly from a single broad category (e.g., mostly food items), split them into specific sub-categories (e.g., "Groceries", "Dining Out", "Coffee & Snacks").
        - Aim for 3 to 6 optimal categories in total to make a clean, readable chart.
        - Output ONLY a valid JSON object where keys are the expense 'id' and values are the string category name. No conversational text.
        
        Example: {"uuid-1": "Groceries", "uuid-2": "Dining Out"}. Data: ${JSON.stringify(expenses)}`;

        const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
          messages: [{ role: 'user', content: prompt }]
        });

        // Safely extract ONLY the JSON object, ignoring any polite AI text
        const rawResponse = aiResponse.response;
        const startIndex = rawResponse.indexOf('{');
        const endIndex = rawResponse.lastIndexOf('}');
        
        if (startIndex === -1 || endIndex === -1) {
          throw new Error("AI failed to generate a JSON object.");
        }
        
        const cleanString = rawResponse.substring(startIndex, endIndex + 1);
        const categoryMap = JSON.parse(cleanString);

        // Let JavaScript do the exact math deterministically
        const calculatedTotals = {};
        expenses.forEach(exp => {
          const categoryName = categoryMap[exp.id] || "Other";
          calculatedTotals[categoryName] = (calculatedTotals[categoryName] || 0) + exp.amount;
        });

        return new Response(JSON.stringify({ analysis: JSON.stringify(calculatedTotals) }), { 
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

    // 3. Existing Telegram Webhook Logic
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
        const welcomeMessage = `👋 *Welcome to your Expense Tracker!*\n\nI'm ready to log your expenses.\n\n📖 *How to log an expense:*\n*Format:* \`[account] <item> <amount>\`\n*Default Account:* ${DEFAULT_ACCOUNT}\n\n*Examples:*\n- \`sib petrol 500\` -> logs 500 to SIB\n- \`petrol 500\` -> logs 500 to SIB\n- \`500 petrol\` -> logs 500 to SIB\n- \`liquid 50 chocolates 100\` -> logs 100 to Cash\n- \`remove petrol 500\` -> Deletes the latest match\n\n*Commands:*\n/expensetoday - Today's summary\n/expensethismonth - This month's summary\n/status - Check bot connection\n/format - Show this formatting guide`;
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
        const formatGuide = `📖 *Expense Bot Formats*\n\n*Standard:* \`[account] <item> <amount>\`\n*Default Account:* ${DEFAULT_ACCOUNT}\n\n*Examples:*\n- \`sib petrol 500\` -> logs 500 to SIB\n- \`petrol 500\` -> logs 500 to SIB\n- \`500 petrol\` -> logs 500 to SIB\n- \`liquid 50 chocolates 100\` -> logs 100 to Cash\n- \`remove petrol 500\` -> Deletes the latest match`;
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
          // Rich confirmation message
          await sendTelegramMessage(chatId, `🗑️ *Removed:* ₹${amount} for ${category} (${account})`, env.TELEGRAM_TOKEN);
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
  // Get current date strictly in IST
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  
  let startIST, endIST, title;
  
  if (period === 'today') {
    // Exactly 12:00 AM to 11:59 PM IST
    startIST = new Date(`${year}-${month}-${day}T00:00:00+05:30`);
    endIST = new Date(`${year}-${month}-${day}T23:59:59+05:30`);
    title = "Today's Expenses";
  } else {
    // Exactly the 1st of the month to the last day of the month IST
    const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
    startIST = new Date(`${year}-${month}-01T00:00:00+05:30`);
    endIST = new Date(`${year}-${month}-${lastDay}T23:59:59+05:30`);
    title = "This Month's Expenses";
  }

  // Convert IST boundaries to strict UTC ISO strings so Supabase doesn't guess the timezone
  const startUTC = startIST.toISOString();
  const endUTC = endIST.toISOString();

  // Query using strictly bounded UTC timestamps
  const { data, error } = await supabase
    .from('expenses')
    .select('account, amount')
    .gte('created_at', startUTC)
    .lte('created_at', endUTC);

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