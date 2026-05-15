import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const USERS_FILE = "users.json";

// =============================
// ✅ USERS
// =============================
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function addUser(id) {
  const users = loadUsers();

  if (!users.includes(id)) {
    users.push(id);
    saveUsers(users);
    console.log("✅ Nuovo utente:", id);
  }
}

// =============================
// ✅ SEND
// =============================
async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    });

    const data = await res.json();
    console.log("Telegram:", data);

  } catch (err) {
    console.log("Errore invio:", err);
  }
}

// =============================
// ✅ INVIO A TUTTI + FALLBACK
// =============================
async function sendToAll(text) {

  let users = loadUsers();

  console.log("Utenti trovati:", users);

  // ✅ manda a tutti
  if (users.length > 0) {
    for (const id of users) {
      await sendMessage(id, text);
    }
  }

  // ✅ fallback (sempre a te)
  await sendMessage(CHAT_ID, text);
}

// =============================
// ✅ WELCOME
// =============================
function welcomeText() {
  return `
👋 Benvenuto!

🔥 I TOP 10 sono i migliori pronostici tra TUTTI i campionati.

📩 Ogni venerdì alle 16 riceverai i pronostici.
`;
}

// =============================
// ✅ HANDLE
// =============================
async function handleUpdate(update) {

  if (!update.message) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;

  if (text === "/start") {

    addUser(chatId);

    await sendMessage(chatId, welcomeText());
  }
}

// =============================
// ✅ LISTENER (solo locale)
// =============================
async function listen() {
  let offset = 0;

  while (true) {

    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}`);
    const data = await res.json();

    for (const update of data.result) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// =============================
// ✅ RUN (cron)
// =============================
async function run() {

  const message = "🔥 TEST BOT FUNZIONANTE";

  console.log("Invio messaggio...");

  await sendToAll(message);
}

// =============================
// ✅ AVVIO
// =============================
if (process.env.RUN_LISTENER === "true") {
  listen();
} else {
  run();
}
