import { createClient } from '@supabase/supabase-js';

// Account Mapping
const accountMap = {
  sib: 'SIB',
  liquid: 'Cash',
  sbi: 'SBI',
  savings: 'Savings' // Added new Savings account
};
const DEFAULT_ACCOUNT = 'SIB';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders, status: 204 });

    // 2. AI Analysis Endpoint
    if (url.pathname === '/api/analyze' && request.method === 'POST') {
      try {
        const { expenses } = await request.json();
        
        // 🚨 FIX 1: Simplify the payload. 
        // Only send the ID and the raw item text so the AI doesn't try to categorize your username or dates.
        const simplifiedData = expenses.map(e => ({
          id: String(e.id),
          item: e.category // Your raw input is saved in the 'category' column
        }));
        
        const prompt = `You are a financial categorizer. Group these items into 3 to 6 broad categories.
        - Output EXACTLY ONE valid JSON object.
        - No conversational text, no explanations, no self-corrections.
        - Format MUST be: {"id": "CategoryName"}
        
        Example: {"1": "Food & Dining", "2": "Transport"}
        Data: ${JSON.stringify(simplifiedData)}`;

        const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
          messages: [{ role: 'user', content: prompt }]
        });

        // 🚨 FIX 2: Bulletproof Regex Parsing
        // This matches all flat JSON objects and ignores any text outside of them.
        const matches = aiResponse.response.match(/\{[^{}]+\}/g);
        
        if (!matches || matches.length === 0) {
          throw new Error("AI failed to generate a JSON object.");
        }
        
        // If the AI self-corrects and outputs two blocks, grab the last (corrected) one
        let cleanString = matches[matches.length - 1].replace(/,\s*}/g, '}');
        
        let categoryMap;
        try {
          categoryMap = JSON.parse(cleanString);
        } catch (parseErr) {
          throw new Error(`${parseErr.message} | AI Output: ${cleanString}`);
        }

        const calculatedTotals = {};
        expenses.forEach(exp => {
          const categoryName = categoryMap[String(exp.id)] || "Other";
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

    // Telegram Webhook Logic
    if (request.method !== 'POST') return new Response('Expense Bot is running!', { status: 200 });

    try {
      const update = await request.json();
      const msg = update.message || update.edited_message;
      if (!msg || !msg.text) return new Response('OK', { status: 200 });

      const isEdit = !!update.edited_message;
      const chatId = msg.chat.id;
      const messageId = msg.message_id; 
      const text = msg.text.trim();
      const command = text.toLowerCase();
      const username = msg.from.username || msg.from.first_name || 'Anonymous';
      const exactTime = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

      // Commands
      if (command === '/start' || command === '/format') {
        const guide = `📖 *Expense Bot Formats*\n\n*Standard:* \`[account] <item> <amount>\`\n*Default Account:* ${DEFAULT_ACCOUNT}\n\n*Examples:*\n- \`sib petrol 500\` -> logs 500 to SIB\n- \`savings lunch 50\` -> logs 50 to Savings\n- \`credit pocket money 500\` -> Adds 500 to Savings balance\n- \`remove petrol 500\` -> Deletes entry\n- \`remove credit pocket money 500\` -> Deletes credit`;
        await sendTelegramMessage(chatId, guide, env.TELEGRAM_TOKEN);
        return new Response('OK', { status: 200 });
      }

      if (command === '/status') {
        await sendTelegramMessage(chatId, "✅ *Bot is online!*", env.TELEGRAM_TOKEN);
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

      // Parser
      let parts = text.split(/\s+/);
      let isRemove = false;
      let isCredit = false;

      if (parts[0].toLowerCase() === 'remove') {
        isRemove = true;
        parts.shift(); 
      }

      if (!parts[0]) return new Response('OK', { status: 200 });

      let account = DEFAULT_ACCOUNT;
      const firstWord = parts[0].toLowerCase();
      
      // Handle the new "credit" keyword
      if (firstWord === 'credit') {
        isCredit = true;
        account = 'Savings';
        parts.shift();
      } else if (accountMap[firstWord]) {
        account = accountMap[firstWord];
        parts.shift();
      }

      if (parts.length < 2) {
         if (!isRemove && !isEdit) await sendTelegramMessage(chatId, "⚠️ Please provide both a category and an amount.", env.TELEGRAM_TOKEN);
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

      // If this is a credit, save it as a negative expense
      if (isCredit) {
        amount = -Math.abs(amount);
      }

      // DB Ops
      if (isRemove) {
        const { data } = await supabase.from('expenses').select('id').eq('account', account).eq('category', category).eq('amount', amount).order('created_at', { ascending: false }).limit(1);
        if (data && data.length > 0) {
          await supabase.from('expenses').delete().eq('id', data[0].id);
          await sendTelegramMessage(chatId, `🗑️ *Removed:* ₹${Math.abs(amount)} for ${category} (${account})`, env.TELEGRAM_TOKEN);
        } else {
          await sendTelegramMessage(chatId, "⚠️ Could not find a matching past entry to remove.", env.TELEGRAM_TOKEN);
        }
      } 
      else if (isEdit) {
        const { error } = await supabase.from('expenses').update({ account, category, amount }).eq('message_id', messageId);
        if (!error) await sendTelegramMessage(chatId, `edited item rs${Math.abs(amount)}`, env.TELEGRAM_TOKEN);
      } 
      else {
        const { data: insertedRow, error } = await supabase.from('expenses').insert([{ username, account, category, amount, message_id: messageId, created_at: exactTime }]).select('id').single();
        if (error) throw error;
        await new Promise(resolve => setTimeout(resolve, 1500));
        const { data: newerRows } = await supabase.from('expenses').select('id').eq('username', username).gt('id', insertedRow.id).limit(1);
        
        if (!newerRows || newerRows.length === 0) {
          if (isCredit) {
            await sendTelegramMessage(chatId, `💰 *Credited:* ₹${Math.abs(amount)} to Savings`, env.TELEGRAM_TOKEN);
          } else {
            await sendTelegramMessage(chatId, "done", env.TELEGRAM_TOKEN);
          }
        }
      }
    } catch (err) {
      console.error('Worker Error:', err.message);
    }
    return new Response('OK', { status: 200 });
  },
};

async function sendTelegramMessage(chatId, text, token) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
  
  let startIST, endIST, title;
  if (period === 'today') {
    startIST = new Date(`${year}-${month}-${day}T00:00:00+05:30`);
    endIST = new Date(`${year}-${month}-${day}T23:59:59+05:30`);
    title = "Today's Expenses";
  } else {
    const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
    startIST = new Date(`${year}-${month}-01T00:00:00+05:30`);
    endIST = new Date(`${year}-${month}-${lastDay}T23:59:59+05:30`);
    title = "This Month's Expenses";
  }

  const { data, error } = await supabase.from('expenses').select('account, amount').gte('created_at', startIST.toISOString()).lte('created_at', endIST.toISOString());

  if (error || !data || data.length === 0) {
    await sendTelegramMessage(chatId, `No expenses recorded for ${period}.`, token);
    return;
  }

  let grandTotal = 0;
  let totalCredits = 0;
  const accountTotals = {};

  data.forEach((row) => {
    const amt = Number(row.amount);
    if (amt < 0) {
      totalCredits += Math.abs(amt);
    } else {
      grandTotal += amt;
      accountTotals[row.account] = (accountTotals[row.account] || 0) + amt;
    }
  });

  let message = `📊 *${title}*\n\n💰 *Total Spent:* ₹${grandTotal.toFixed(2)}`;
  if (totalCredits > 0) message += `\n💵 *Total Credited:* ₹${totalCredits.toFixed(2)}`;
  message += `\n\n*By Account:*\n`;
  
  for (const [acc, amt] of Object.entries(accountTotals)) {
    message += `• ${acc}: ₹${amt.toFixed(2)}\n`;
  }
  await sendTelegramMessage(chatId, message, token);
}