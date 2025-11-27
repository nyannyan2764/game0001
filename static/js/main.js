const socket = io();

// 状態管理
let myUUID = localStorage.getItem('azure_game_uuid');
if (!myUUID) {
    myUUID = crypto.randomUUID();
    localStorage.setItem('azure_game_uuid', myUUID);
}

let mySid = null;
let myRole = 'citizen';

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

// 接続後、UUIDを送って復帰判定
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
    // 画面遷移はstatus updateで制御されるが、初回ログイン時はロビーへ
    showScreen('lobby');
});

socket.on('error_msg', (data) => {
    alert(data.msg);
});

// 2. 設定変更 (ロビー)
const settingsInputs = ['set-rounds', 'set-error', 'set-multi'];
settingsInputs.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
        const rounds = document.getElementById('set-rounds').value;
        const error = document.getElementById('set-error').value;
        const multi = document.getElementById('set-multi').value;
        socket.emit('update_settings', {
            total_rounds: rounds,
            error_margin: error,
            traitor_multiplier: multi
        });
    });
});

// 準備完了
document.getElementById('ready-btn').addEventListener('click', () => {
    socket.emit('toggle_ready');
});

// 3. ゲーム全体の状態更新
socket.on('update_status', (data) => {
    // 設定反映
    if(data.status === 'LOBBY') {
        document.getElementById('set-rounds').value = data.settings.total_rounds;
        document.getElementById('set-error').value = data.settings.error_margin;
        document.getElementById('set-multi').value = data.settings.traitor_multiplier;
        
        // ルール表示更新
        document.getElementById('rule-error-val').innerText = data.settings.error_margin;
        document.getElementById('rule-error-val-2').innerText = data.settings.error_margin;
    }

    // プレイヤーリスト更新 (ロビー & サイドバー)
    updatePlayerLists(data.players, data.status);

    // 画面遷移制御
    if (data.status === 'LOBBY') showScreen('lobby');
    else if (data.status === 'PLAYING') showScreen('game');
    else if (data.status === 'VOTING') showScreen('voting');
    else if (data.status === 'RESULT') showScreen('result');

    // 自分の役割再確認（リロード時など）
    const me = data.players.find(p => p.sid === mySid);
    if(me) {
        myRole = me.role; // サーバー側の最新ロール
        updateRoleDisplay();
    }
    
    // ロビーの準備ボタン状態
    const readyBtn = document.getElementById('ready-btn');
    if (me && me.is_ready) {
        readyBtn.classList.add('ready');
        readyBtn.innerText = "準備OK";
    } else {
        readyBtn.classList.remove('ready');
        readyBtn.innerText = "準備完了";
    }
});

function updatePlayerLists(players, status) {
    // ロビーリスト
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

    // スコアリスト (サイドバー)
    const scoreList = document.getElementById('score-list');
    scoreList.innerHTML = '';
    players.forEach(p => {
        const li = document.createElement('li');
        li.className = 'score-item';
        // ゲーム中・結果時はポイントを表示
        const scoreText = (status === 'LOBBY') ? '-' : `${p.score}pt`;
        li.innerHTML = `<span>${p.name}</span> <span style="color:var(--accent-gold)">${scoreText}</span>`;
        scoreList.appendChild(li);
    });
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
// Enterキーでも送信
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
    // メインとサイドバー両方に追加
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
    // 画面リセット
    document.getElementById('round-result-overlay').classList.remove('active');
    document.getElementById('my-answer-controls').style.display = "none";
    document.getElementById('next-round-btn').style.display = "inline-block";
    document.getElementById('next-wait-msg').style.display = "none";

    document.getElementById('current-round-num').innerText = data.round;
    document.getElementById('quiz-text').innerText = data.quiz;
    document.getElementById('answerer-name').innerText = data.answerer_name;
    document.getElementById('unit-label').innerText = data.unit;
    document.getElementById('hint-value').innerText = "..."; // 裏切り者用ヒントは別途
});

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

// 結果表示
socket.on('round_result', (data) => {
    const overlay = document.getElementById('round-result-overlay');
    document.getElementById('res-user-ans').innerText = `${data.user_ans} ${data.unit}`;
    document.getElementById('res-true-ans').innerText = `${data.true_ans} ${data.unit}`;
    document.getElementById('res-error').innerText = data.error;
    document.getElementById('res-winner').innerText = data.winner;
    
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
    const container = document.getElementById('vote-buttons');
    container.innerHTML = '';
    
    // プレイヤーリスト取得のためDOM参照（またはメモリ保持）
    // update_statusで最新リストがメモリにあると仮定、あるいはサイドバーから取得
    const items = document.querySelectorAll('#lobby-player-list li span:first-child');
    // 簡単のためサーバーにリクエストしてないが、update_statusで受け取ったデータを使いたい。
    // ここではグローバル変数はないので、sidebarのDOMから名前を取得するのは不確実。
    // update_statusのdata.playersをグローバル変数に保存するのが適切
});

// 投票画面構築は update_status 内で行うのが安全だが、ロジック分離のためここで
let currentPlayers = [];
socket.on('update_status', (data) => {
    currentPlayers = data.players;
    if(data.status === 'VOTING') renderVoteButtons(data.players);
});

function renderVoteButtons(players) {
    const container = document.getElementById('vote-buttons');
    if(container.children.length > 0) return; // 既に描画済みならスキップ

    players.forEach(p => {
        if (p.sid === mySid) return; // 自分には投票できない

        const btn = document.createElement('button');
        btn.className = 'vote-btn';
        btn.innerText = p.name;
        btn.onclick = () => {
            // 全てのボタンの選択状態解除
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
    
    const rankList = document.getElementById('final-ranking');
    rankList.innerHTML = '';
    data.ranking.forEach((p, index) => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span>#${index+1} ${p.name} (${p.role === 'traitor' ? '裏' : '市'})</span>
            <span>${p.score}pt</span>
        `;
        rankList.appendChild(li);
    });
});

document.getElementById('game-reset-btn').addEventListener('click', () => {
    socket.emit('reset_game_ack');
    document.getElementById('game-reset-btn').style.display = "none";
    document.getElementById('reset-wait-msg').style.display = "block";
});

socket.on('reload_game', () => {
    // 全リセット
    location.reload();
});

// --- サイドバー制御 ---
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarClose = document.getElementById('sidebar-close');

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.add('open');
});
sidebarClose.addEventListener('click', () => {
    sidebar.classList.remove('open');
});