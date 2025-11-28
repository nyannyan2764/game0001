const socket = io();

// 状態管理
let myUUID = localStorage.getItem('azure_game_uuid');
if (!myUUID) {
    myUUID = crypto.randomUUID();
    localStorage.setItem('azure_game_uuid', myUUID);
}

let mySid = null;
let myRole = 'citizen';
let gameSettings = {};
let timerInterval = null;

// DOM要素
const screens = {
    login: document.getElementById('login-screen'),
    lobby: document.getElementById('lobby-screen'),
    game: document.getElementById('game-screen'),
    voting: document.getElementById('voting-screen'),
    result: document.getElementById('result-screen')
};

// --- 初期化 ---
function showScreen(screenId) {
    Object.values(screens).forEach(el => el.classList.remove('active'));
    screens[screenId].classList.add('active');
}

socket.on('connect', () => {
    console.log("Connected");
});

// --- イベントリスナー設定 ---

// 1. 参加
document.getElementById('join-btn').addEventListener('click', () => {
    const name = document.getElementById('username').value.trim();
    if (!name) return alert("名前を入力してください");
    socket.emit('join_game', { name: name, uuid: myUUID });
});

socket.on('self_info', (data) => {
    mySid = data.sid;
    myRole = data.role;
    updateRoleDisplay();
});

socket.on('error_msg', (data) => {
    alert(data.msg);
});

// 2. 設定変更 (ロビー)
const settingsInputs = ['set-rounds', 'set-error', 'set-multi', 'set-time'];
settingsInputs.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
        const rounds = document.getElementById('set-rounds').value;
        const error = document.getElementById('set-error').value;
        const multi = document.getElementById('set-multi').value;
        const timeLimit = document.getElementById('set-time').value;
        
        socket.emit('update_settings', {
            total_rounds: rounds,
            error_margin: error,
            traitor_multiplier: multi,
            time_limit: timeLimit
        });
    });
});

// 準備完了
document.getElementById('ready-btn').addEventListener('click', () => {
    socket.emit('toggle_ready');
});

// 3. ゲーム全体の状態更新
socket.on('update_status', (data) => {
    gameSettings = data.settings;

    // 設定反映
    if(data.status === 'LOBBY') {
        document.getElementById('set-rounds').value = data.settings.total_rounds;
        document.getElementById('set-error').value = data.settings.error_margin;
        document.getElementById('set-multi').value = data.settings.traitor_multiplier;
        document.getElementById('set-time').value = data.settings.time_limit;
        
        document.getElementById('rule-error-val').innerText = data.settings.error_margin;
        document.getElementById('rule-error-val-2').innerText = data.settings.error_margin;
        document.getElementById('rule-time-val').innerText = data.settings.time_limit;
    }

    updatePlayerLists(data.players);
    updateTeamScores(data.team_scores);

    if (data.status === 'LOBBY') showScreen('lobby');
    else if (data.status === 'PLAYING') showScreen('game');
    else if (data.status === 'VOTING') showScreen('voting');
    else if (data.status === 'RESULT') showScreen('result');

    const me = data.players.find(p => p.sid === mySid);
    if(me) {
        myRole = me.role;
        updateRoleDisplay();
    }
    
    const readyBtn = document.getElementById('ready-btn');
    if (me && me.is_ready) {
        readyBtn.classList.add('ready');
        readyBtn.innerText = "準備OK";
    } else {
        readyBtn.classList.remove('ready');
        readyBtn.innerText = "準備完了";
    }

    // 復帰時などのクイズ情報復元
    if(data.status === 'PLAYING' && data.current_quiz_data) {
        document.getElementById('current-round-num').innerText = data.current_round;
        document.getElementById('quiz-text').innerText = data.current_quiz_data.q;
        document.getElementById('unit-label').innerText = data.current_quiz_data.u;
        
        // 復帰時タイマー再開ロジックは new_round イベントで elapsed_time が来るのを待つか、
        // ここでは正確な時間が分からないため表示更新しない（new_roundで同期される）
    }
});

function updatePlayerLists(players) {
    const lobbyList = document.getElementById('lobby-player-list');
    lobbyList.innerHTML = '';
    players.forEach(p => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span>${p.name}</span>
            <span style="color:${p.is_ready ? '#f59e0b' : '#64748b'}">
                ${p.is_ready ? '<i class="fas fa-check"></i> OK' : '...'}
            </span>
        `;
        lobbyList.appendChild(li);
    });

    const sidebarList = document.getElementById('sidebar-player-list');
    sidebarList.innerHTML = '';
    players.forEach(p => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${p.name}</span>`;
        sidebarList.appendChild(li);
    });
}

function updateTeamScores(scores) {
    if(!scores) return;
    document.getElementById('score-citizen-val').innerText = `${scores.citizen}pt`;
    document.getElementById('score-traitor-val').innerText = `${scores.traitor}pt`;
    
    document.getElementById('final-citizen-point').innerText = `${scores.citizen}pt`;
    document.getElementById('final-traitor-point').innerText = `${scores.traitor}pt`;
}

function updateRoleDisplay() {
    const disp = document.getElementById('my-role-display');
    const hint = document.getElementById('traitor-hint');
    if (myRole === 'traitor') {
        disp.innerText = "裏切り者";
        disp.style.color = "var(--accent-red)";
        hint.style.display = "inline";
    } else {
        disp.innerText = "市民";
        disp.style.color = "var(--accent-blue)";
        hint.style.display = "none";
    }
}

// 4. チャット
document.getElementById('send-chat-btn').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if(e.key === 'Enter') sendChat();
});

function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if(msg) {
        socket.emit('send_chat', { msg: msg });
        input.value = '';
    }
}

socket.on('chat_receive', (entry) => {
    appendChat(entry);
});
socket.on('chat_history', (logs) => {
    const chatBox = document.getElementById('game-chat-box');
    const sideBox = document.getElementById('chat-history');
    chatBox.innerHTML = '';
    sideBox.innerHTML = '';
    logs.forEach(appendChat);
});

function appendChat(entry) {
    const targets = [document.getElementById('game-chat-box'), document.getElementById('chat-history')];
    targets.forEach(box => {
        const div = document.createElement('div');
        div.className = `chat-msg ${entry.type}`;
        if(entry.type === 'system') {
            div.innerText = entry.text;
        } else {
            div.innerHTML = `<span>${entry.name}:</span> ${entry.text}`;
        }
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    });
}

// 5. ゲーム進行 (ラウンド)
socket.on('new_round', (data) => {
    document.getElementById('round-result-overlay').classList.remove('active');
    document.getElementById('my-answer-controls').style.display = "none";
    document.getElementById('next-round-btn').style.display = "inline-block";
    document.getElementById('next-wait-msg').style.display = "none";

    document.getElementById('current-round-num').innerText = data.round;
    document.getElementById('quiz-text').innerText = data.quiz;
    document.getElementById('answerer-name').innerText = data.answerer_name;
    document.getElementById('unit-label').innerText = data.unit;
    document.getElementById('hint-value').innerText = "...";
    
    // タイマー開始
    startTimer(data.elapsed_time || 0);
});

function startTimer(elapsedSeconds) {
    if(timerInterval) clearInterval(timerInterval);
    
    const limitMinutes = parseInt(gameSettings.time_limit || 3);
    const totalSeconds = limitMinutes * 60;
    let remaining = totalSeconds - elapsedSeconds;
    
    const display = document.getElementById('time-remaining');
    
    function updateDisplay() {
        if(remaining <= 0) {
            remaining = 0;
            if(timerInterval) clearInterval(timerInterval);
            display.innerText = "00:00";
            display.style.color = "red";
            return;
        }
        
        const m = Math.floor(remaining / 60);
        const s = Math.floor(remaining % 60);
        display.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        display.style.color = remaining < 30 ? "red" : "white";
        remaining--;
    }
    
    updateDisplay();
    timerInterval = setInterval(updateDisplay, 1000);
}


socket.on('traitor_hint', (data) => {
    document.getElementById('hint-value').innerText = data.answer;
});

socket.on('your_turn_to_answer', () => {
    document.getElementById('my-answer-controls').style.display = "block";
});

document.getElementById('submit-answer-btn').addEventListener('click', () => {
    const ans = document.getElementById('final-answer').value;
    if(ans === "") return;
    socket.emit('submit_answer', { answer: ans });
    document.getElementById('final-answer').value = '';
});

socket.on('round_result', (data) => {
    const overlay = document.getElementById('round-result-overlay');
    document.getElementById('res-user-ans').innerText = `${data.user_ans} ${data.unit}`;
    document.getElementById('res-true-ans').innerText = `${data.true_ans} ${data.unit}`;
    document.getElementById('res-error').innerText = data.error;
    document.getElementById('res-winner').innerText = data.winner;
    
    // タイマーストップ
    if(timerInterval) clearInterval(timerInterval);
    
    overlay.classList.add('active');
});

document.getElementById('next-round-btn').addEventListener('click', () => {
    socket.emit('next_round_ack');
    document.getElementById('next-round-btn').style.display = "none";
    document.getElementById('next-wait-msg').style.display = "block";
});

// 6. 投票
socket.on('start_voting', () => {
    document.getElementById('round-result-overlay').classList.remove('active');
    if(timerInterval) clearInterval(timerInterval);
});

socket.on('update_status', (data) => {
    if(data.status === 'VOTING') {
        renderVoteButtons(data.players);
    }
    if(data.status === 'RESULT' && data.winner_team) {
         const citBadge = document.getElementById('citizen-win-lose');
         const traBadge = document.getElementById('traitor-win-lose');
         
         if(data.winner_team === 'citizen') {
             citBadge.innerText = "WIN"; citBadge.style.background = "var(--accent-gold)"; citBadge.style.color="black";
             traBadge.innerText = "LOSE"; traBadge.style.background = "#333"; traBadge.style.color="white";
         } else if (data.winner_team === 'traitor') {
             traBadge.innerText = "WIN"; traBadge.style.background = "var(--accent-gold)"; traBadge.style.color="black";
             citBadge.innerText = "LOSE"; citBadge.style.background = "#333"; citBadge.style.color="white";
         } else {
             citBadge.innerText = "DRAW";
             traBadge.innerText = "DRAW";
         }
    }
});

function renderVoteButtons(players) {
    const container = document.getElementById('vote-buttons');
    if(container.children.length > 0) return;

    players.forEach(p => {
        if (p.sid === mySid) return;

        const btn = document.createElement('button');
        btn.className = 'vote-btn';
        btn.innerText = p.name;
        btn.onclick = () => {
            Array.from(container.children).forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            
            if(confirm(`${p.name} を裏切り者として指名しますか？`)) {
                socket.emit('submit_vote', { target_sid: p.sid });
                container.innerHTML = '<p>投票しました。待機中...</p>';
            }
        };
        container.appendChild(btn);
    });
}

// 7. ゲーム終了
socket.on('game_over', (data) => {
    document.getElementById('final-message').innerText = data.msg;
    document.getElementById('final-traitor-name').innerText = data.traitor_name;
    if(timerInterval) clearInterval(timerInterval);
});

document.getElementById('game-reset-btn').addEventListener('click', () => {
    socket.emit('reset_game_ack');
    document.getElementById('game-reset-btn').style.display = "none";
    document.getElementById('reset-wait-msg').style.display = "block";
});

socket.on('reload_game', () => {
    location.reload();
});

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarClose = document.getElementById('sidebar-close');

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.add('open');
});
sidebarClose.addEventListener('click', () => {
    sidebar.classList.remove('open');
});