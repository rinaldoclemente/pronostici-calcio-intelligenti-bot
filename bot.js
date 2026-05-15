import fs from "fs";

const TOKEN = process.env.BOT_TOKEN;

const USERS_FILE = "users.json";

// =============================
// ✅ CARICA UTENTI
// =============================
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch {
    return [];
  }
}

// =============================
// ✅ SALVA UTENTI
// =============================
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users));
}

// =============================
// ✅ AGGIUNGI UTENTE
// =============================
function addUser(id) {
  let users = loadUsers();

  if (!users.includes(id)) {
    users.push(id);
    saveUsers(users);
    console.log("✅ Nuovo utente:", id);
  }
}

// =============================
// ✅ INVIO A TUTTI
// =============================
async function sendToAll(text) {
  const users = loadUsers();

  for (const id of users) {
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text
        })
      });
    } catch {
      console.log("Errore invio a:", id);
    }
  }
}

// =============================
// ✅ WELCOME
// =============================
function welcomeText() {
  return `
👋 Benvenuto!

🔥 I TOP 10 sono i migliori pronostici tra TUTTI i campionati.

📩 Ogni venerdì alle 16 riceverai i suggerimenti.
`;
}

// =============================
// ✅ HANDLE UPDATE
// =============================
async function handleUpdate(update) {

  if (!update.message) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;

  if (text === "/start") {
    addUser(chatId);
    await sendToAll("✅ Nuovo utente registrato!");
    
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: welcomeText()
      })
    });
  }
}

// =============================
// ✅ LISTENER
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
// ✅ RUN (INVIO PRONOSTICI)
// =============================
async function run() {

  const message = "🔥 TOP 10 PRONOSTICI DELLA SETTIMANA";

  await sendToAll(message);
}

// =============================
if (process.env.RUN_LISTENER === "true") {
  listen();
} else {
  run();
}
