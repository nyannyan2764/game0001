import random
import uuid
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room
from quiz_data import QUIZ_LIST

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_key_azure_game_horafuki'
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*")

# --- ゲーム状態管理クラス ---
class GameState:
    def __init__(self):
        self.reset_game()

    def reset_game(self):
        self.players = {}  # {sid: {name, score, is_ready, role, id(uuid)}}
        self.settings = {
            "total_rounds": 3,
            "error_margin": 10,  # %, これ以上ズレると裏切り者の得点
            "traitor_multiplier": 2, # 投票外した場合の倍率
        }
        self.status = "LOBBY"  # LOBBY, PLAYING, VOTING, RESULT
        self.current_round = 0
        self.used_quizzes = []
        self.current_quiz = None
        self.current_answerer_index = 0
        self.traitor_sid = None
        self.round_result = {} # {answer, error_percent, point_winner}
        self.votes = {} # {voter_sid: target_sid}
        self.ack_next = set() # 次へボタンを押した人のID
        self.ack_game_over = set()
        self.chat_log = []
        self.uuid_map = {} # {uuid: sid} 再接続用

    def get_player_list(self):
        return [{"name": p["name"], "score": p["score"], "is_ready": p["is_ready"], "sid": sid, "id": p["id"]} 
                for sid, p in self.players.items()]

game = GameState()

@app.route('/')
def index():
    return render_template('index.html')

# --- SocketIO イベント ---

@socketio.on('connect')
def on_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('join_game')
def on_join(data):
    user_uuid = data.get('uuid')
    user_name = data.get('name')
    
    # 復帰処理または新規参加
    existing_sid = game.uuid_map.get(user_uuid)
    
    if existing_sid and existing_sid in game.players:
        # 以前の情報があり、プレイヤーリストに残っている場合（情報の引継ぎ）
        old_player_data = game.players[existing_sid]
        del game.players[existing_sid] # 古いSID削除
        game.players[request.sid] = old_player_data
        game.uuid_map[user_uuid] = request.sid
        # プレイヤー自身の情報を返す
        emit('self_info', {'sid': request.sid, 'role': old_player_data['role']})
    else:
        # 新規
        if game.status != "LOBBY":
             emit('error_msg', {'msg': 'ゲーム進行中のため参加できません'})
             return
             
        game.players[request.sid] = {
            "name": user_name,
            "score": 0,
            "is_ready": False,
            "role": "citizen",
            "id": user_uuid
        }
        game.uuid_map[user_uuid] = request.sid
        emit('self_info', {'sid': request.sid, 'role': 'citizen'})

    # 状態同期
    emit_update_all()
    # チャット履歴送信
    emit('chat_history', game.chat_log)

@socketio.on('update_settings')
def on_update_settings(data):
    if game.status == "LOBBY":
        game.settings.update(data)
        emit_update_all()

@socketio.on('toggle_ready')
def on_toggle_ready():
    if request.sid in game.players:
        game.players[request.sid]['is_ready'] = not game.players[request.sid]['is_ready']
        emit_update_all()
        check_start_game()

def check_start_game():
    if len(game.players) >= 2 and all(p['is_ready'] for p in game.players.values()):
        start_game()

def start_game():
    game.status = "PLAYING"
    game.current_round = 0
    game.used_quizzes = []
    game.chat_log.append({"type": "system", "text": "=== ゲーム開始 ==="})
    
    # 裏切り者決定
    sids = list(game.players.keys())
    game.traitor_sid = random.choice(sids)
    for sid in game.players:
        game.players[sid]['role'] = 'traitor' if sid == game.traitor_sid else 'citizen'
        # 各個人に役割通知
        emit('role_assigned', {'role': game.players[sid]['role']}, room=sid)
    
    start_new_round()

def start_new_round():
    game.current_round += 1
    game.ack_next = set()
    
    if game.current_round > int(game.settings['total_rounds']):
        start_voting_phase()
        return

    # クイズ選択（重複なし）
    available = [q for q in QUIZ_LIST if q not in game.used_quizzes]
    if not available:
        available = QUIZ_LIST # 使い切ったらリセットまたはエラー処理（ここではリサイクル）
    
    game.current_quiz = random.choice(available)
    game.used_quizzes.append(game.current_quiz)
    
    # 回答者指名（ラウンド数に応じてローテーション）
    sids = list(game.players.keys())
    # 順番: (ラウンド-1) % 人数
    ans_idx = (game.current_round - 1) % len(sids)
    game.current_answerer_sid = sids[ans_idx]
    
    # クイズ情報送信
    game.chat_log.append({"type": "system", "text": f"第{game.current_round}問: {game.current_quiz['q']}"})
    
    payload = {
        "round": game.current_round,
        "quiz": game.current_quiz['q'],
        "unit": game.current_quiz['u'],
        "answerer_name": game.players[game.current_answerer_sid]['name'],
        "is_answerer": False
    }
    
    emit('new_round', payload, broadcast=True)
    
    # 回答者へ通知
    emit('your_turn_to_answer', {}, room=game.current_answerer_sid)
    
    # 裏切り者へ正解通知
    emit('traitor_hint', {"answer": game.current_quiz['a']}, room=game.traitor_sid)
    
    emit_update_all()

@socketio.on('send_chat')
def on_chat(data):
    if request.sid in game.players:
        name = game.players[request.sid]['name']
        msg = data.get('msg')
        entry = {"type": "user", "name": name, "text": msg}
        game.chat_log.append(entry)
        emit('chat_receive', entry, broadcast=True)

@socketio.on('submit_answer')
def on_submit_answer(data):
    if request.sid != game.current_answerer_sid:
        return
        
    try:
        user_ans = float(data.get('answer'))
    except ValueError:
        return

    true_ans = game.current_quiz['a']
    
    # 誤差計算 (|回答 - 正解| / 正解) * 100
    if true_ans == 0:
        error_pct = abs(user_ans - true_ans) * 100 # 0の場合の特例
    else:
        error_pct = abs((user_ans - true_ans) / true_ans) * 100
    
    # ポイント判定
    # 誤差が設定値以上 -> 裏切り者のポイント
    threshold = float(game.settings['error_margin'])
    points = 100
    winner_role = ""
    
    if error_pct >= threshold:
        # 裏切り者勝利（誤答させた）
        game.players[game.traitor_sid]['score'] += points
        winner_role = "裏切り者"
    else:
        # 市民勝利（正解に近い）
        for sid, p in game.players.items():
            if p['role'] == 'citizen':
                p['score'] += points
        winner_role = "市民チーム"

    game.round_result = {
        "user_ans": user_ans,
        "true_ans": true_ans,
        "error": round(error_pct, 2),
        "winner": winner_role,
        "unit": game.current_quiz['u']
    }
    
    game.chat_log.append({"type": "system", "text": f"回答: {user_ans} (正解: {true_ans}) 誤差: {game.round_result['error']}% -> {winner_role}に{points}pt"})
    emit('round_result', game.round_result, broadcast=True)
    emit_update_all()

@socketio.on('next_round_ack')
def on_next_ack():
    game.ack_next.add(request.sid)
    # 全員がAckしたら次へ
    if len(game.ack_next) >= len(game.players):
        start_new_round()

def start_voting_phase():
    game.status = "VOTING"
    game.votes = {}
    emit('start_voting', {}, broadcast=True)
    emit_update_all()

@socketio.on('submit_vote')
def on_submit_vote(data):
    target_sid = data.get('target_sid')
    # 自分には投票不可などのチェックはフロントでもやるがここでも
    if target_sid == request.sid: 
        return
    
    game.votes[request.sid] = target_sid
    
    # 全員投票完了確認
    if len(game.votes) >= len(game.players):
        calc_final_result()

def calc_final_result():
    game.status = "RESULT"
    
    # 最多得票者を計算
    vote_counts = {}
    for vid, tid in game.votes.items():
        vote_counts[tid] = vote_counts.get(tid, 0) + 1
    
    # 最多得票者（複数いる場合は全員吊られる扱いにするか、ランダムか。今回は全員対象）
    max_votes = 0
    if vote_counts:
        max_votes = max(vote_counts.values())
    
    suspects = [sid for sid, count in vote_counts.items() if count == max_votes]
    
    traitor_found = game.traitor_sid in suspects
    
    final_msg = ""
    multiplier = float(game.settings['traitor_multiplier'])
    
    if traitor_found:
        # 裏切り者発見 -> 裏切り者の負け（スコア0 または 市民ボーナスだが、要件「問答無用で負け」）
        # ゲーム的な「負け」＝スコア没収とするか、フラグ管理するか。
        # ここでは裏切り者のスコアを0にし、市民にボーナスを加算するなどの処理
        game.players[game.traitor_sid]['score'] = -9999 # 圧倒的敗北
        final_msg = "裏切り者が追放されました！市民の勝利です！"
    else:
        # 裏切り者逃げ切り -> 裏切り者のスコアn倍
        game.players[game.traitor_sid]['score'] = int(game.players[game.traitor_sid]['score'] * multiplier)
        final_msg = f"裏切り者は逃げ切りました... 裏切り者のスコアが{multiplier}倍になります！"

    # ランキング作成
    ranking = sorted(game.players.items(), key=lambda x: x[1]['score'], reverse=True)
    
    result_data = {
        "msg": final_msg,
        "traitor_name": game.players[game.traitor_sid]['name'],
        "ranking": [{"name": p['name'], "score": p['score'], "role": p['role']} for sid, p in ranking]
    }
    
    game.chat_log.append({"type": "system", "text": f"ゲーム終了。{final_msg}"})
    emit('game_over', result_data, broadcast=True)
    emit_update_all()

@socketio.on('reset_game_ack')
def on_reset_ack():
    game.ack_game_over.add(request.sid)
    if len(game.ack_game_over) >= len(game.players):
        game.reset_game()
        emit('reload_game', broadcast=True)

@socketio.on('disconnect')
def on_disconnect():
    print(f"Client disconnected: {request.sid}")
    # ゲーム中であればプレイヤーデータは消さない（復帰待ち）
    # ただし全員いなくなったらリセットするなどの処理は必要だが、今回はシンプルに保持

def emit_update_all():
    # 全員に最新のステータス（待機状況、スコアなど）を送る
    emit('update_status', {
        "status": game.status,
        "players": game.get_player_list(),
        "settings": game.settings,
        "current_round": game.current_round,
        "traitor_sid": game.traitor_sid # クライアントには送るが、JS側で見せないように制御
    }, broadcast=True)

if __name__ == '__main__':
    socketio.run(app, debug=True)