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
        self.players = {} # {sid: {name, is_ready, role, id(uuid)}}
        self.team_scores = { "citizen": 0, "traitor": 0 }
        self.settings = {
            "total_rounds": 3,
            "error_margin": 10,  # %
            "traitor_multiplier": 2, # 投票外した場合の倍率
        }
        self.status = "LOBBY"  # LOBBY, PLAYING, VOTING, RESULT
        self.current_round = 0
        self.used_quizzes = []
        self.current_quiz = None
        self.current_answerer_sid = None
        self.traitor_sid = None
        self.round_result = {}
        self.votes = {}
        self.ack_next = set()
        self.ack_game_over = set()
        self.chat_log = []
        self.uuid_map = {} # {uuid: sid}

    def get_player_list(self):
        return [{"name": p["name"], "is_ready": p["is_ready"], "sid": sid, "id": p["id"], "role": p["role"]} 
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
    
    # --- 復帰処理 ---
    existing_sid = game.uuid_map.get(user_uuid)
    
    # 既存IDがあり、かつプレイヤーリストに残っている場合 (復帰)
    if existing_sid and existing_sid in game.players:
        old_player_data = game.players[existing_sid]
        del game.players[existing_sid] # 古いSID削除
        game.players[request.sid] = old_player_data # 新しいSIDで登録
        game.uuid_map[user_uuid] = request.sid # マップ更新
        
        # プレイヤー自身の情報を返す
        emit('self_info', {'sid': request.sid, 'role': old_player_data['role']})
        
        # 復帰時に現在のクイズ情報を個別に送る（画面真っ白防止）
        if game.status == "PLAYING" and game.current_quiz:
             payload = {
                "round": game.current_round,
                "quiz": game.current_quiz['q'],
                "unit": game.current_quiz['u'],
                "answerer_name": game.players[game.current_answerer_sid]['name'] if game.current_answerer_sid in game.players else "不明"
            }
             emit('new_round', payload, room=request.sid)
             if game.current_answerer_sid == request.sid:
                 emit('your_turn_to_answer', {}, room=request.sid)
             if old_player_data['role'] == 'traitor':
                 emit('traitor_hint', {"answer": game.current_quiz['a']}, room=request.sid)

        game.chat_log.append({"type": "system", "text": f"{old_player_data['name']}さんが復帰しました。"})

    else:
        # --- 新規参加 ---
        if game.status != "LOBBY":
             emit('error_msg', {'msg': 'ゲーム進行中のため参加できません'})
             return
             
        game.players[request.sid] = {
            "name": user_name,
            "is_ready": False,
            "role": "citizen", # 初期値
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
    game.team_scores = {"citizen": 0, "traitor": 0} # チームスコアリセット
    game.chat_log.append({"type": "system", "text": "=== ゲーム開始 ==="})
    
    # 裏切り者決定 (必ず1人選出)
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
        available = QUIZ_LIST
    
    game.current_quiz = random.choice(available)
    game.used_quizzes.append(game.current_quiz)
    
    # 回答者指名
    sids = list(game.players.keys())
    ans_idx = (game.current_round - 1) % len(sids)
    game.current_answerer_sid = sids[ans_idx]
    
    # クイズ情報送信
    game.chat_log.append({"type": "system", "text": f"第{game.current_round}問: {game.current_quiz['q']}"})
    
    payload = {
        "round": game.current_round,
        "quiz": game.current_quiz['q'],
        "unit": game.current_quiz['u'],
        "answerer_name": game.players[game.current_answerer_sid]['name']
    }
    
    emit('new_round', payload, broadcast=True)
    
    # 回答者へ通知
    emit('your_turn_to_answer', {}, room=game.current_answerer_sid)
    
    # 裏切り者へ正解通知 (確実に送る)
    if game.traitor_sid in game.players:
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
    
    # 誤差計算
    if true_ans == 0:
        error_pct = abs(user_ans - true_ans) * 100
    else:
        error_pct = abs((user_ans - true_ans) / true_ans) * 100
    
    # ポイント判定（チームスコアに加算）
    threshold = float(game.settings['error_margin'])
    points = 100
    winner_role_msg = ""
    
    if error_pct >= threshold:
        # 裏切り者チーム勝利
        game.team_scores['traitor'] += points
        winner_role_msg = "裏切り者"
    else:
        # 市民チーム勝利
        game.team_scores['citizen'] += points
        winner_role_msg = "市民チーム"

    game.round_result = {
        "user_ans": user_ans,
        "true_ans": true_ans,
        "error": round(error_pct, 2),
        "winner": winner_role_msg,
        "unit": game.current_quiz['u']
    }
    
    game.chat_log.append({"type": "system", "text": f"回答: {user_ans} (正解: {true_ans}) 誤差: {game.round_result['error']}% -> {winner_role_msg}に{points}pt"})
    emit('round_result', game.round_result, broadcast=True)
    emit_update_all()

@socketio.on('next_round_ack')
def on_next_ack():
    game.ack_next.add(request.sid)
    # 現在接続中のプレイヤー数で判定（切断者を待たないため）
    current_players_count = len([sid for sid in game.players if sid in socketio.server.eio.sockets])
    if len(game.ack_next) >= current_players_count and current_players_count > 0:
        start_new_round()

def start_voting_phase():
    game.status = "VOTING"
    game.votes = {}
    emit('start_voting', {}, broadcast=True)
    emit_update_all()

@socketio.on('submit_vote')
def on_submit_vote(data):
    target_sid = data.get('target_sid')
    if target_sid == request.sid: 
        return
    
    game.votes[request.sid] = target_sid
    
    # 現在接続中のプレイヤー数で判定
    current_players_count = len([sid for sid in game.players if sid in socketio.server.eio.sockets])
    if len(game.votes) >= current_players_count and current_players_count > 0:
        calc_final_result()

def calc_final_result():
    game.status = "RESULT"
    
    # 最多得票者を計算
    vote_counts = {}
    for vid, tid in game.votes.items():
        vote_counts[tid] = vote_counts.get(tid, 0) + 1
    
    max_votes = 0
    if vote_counts:
        max_votes = max(vote_counts.values())
    
    suspects = [sid for sid, count in vote_counts.items() if count == max_votes]
    
    traitor_found = game.traitor_sid in suspects
    
    final_msg = ""
    multiplier = float(game.settings['traitor_multiplier'])
    winner_team = ""
    
    # 最終結果判定とスコア変動
    if traitor_found:
        # 裏切り者発見 -> 市民の勝ち
        # 裏切り者のスコアを0にする（問答無用で負け）
        game.team_scores['traitor'] = 0
        final_msg = "裏切り者が追放されました！市民チームの完全勝利です！"
        winner_team = "citizen"
    else:
        # 裏切り者逃げ切り -> 裏切り者のスコアn倍
        game.team_scores['traitor'] = int(game.team_scores['traitor'] * multiplier)
        final_msg = f"裏切り者は逃げ切りました... 裏切り者のスコアが{multiplier}倍になります！"
        # スコアで最終勝敗判定
        if game.team_scores['traitor'] > game.team_scores['citizen']:
             winner_team = "traitor"
             final_msg += " 裏切り者チームの勝利！"
        elif game.team_scores['citizen'] > game.team_scores['traitor']:
             winner_team = "citizen"
             final_msg += " それでも市民チームの勝利！"
        else:
             winner_team = "draw"
             final_msg += " 引き分け！"

    traitor_name = "不明"
    if game.traitor_sid and game.traitor_sid in game.players:
        traitor_name = game.players[game.traitor_sid]['name']
    
    result_data = {
        "msg": final_msg,
        "traitor_name": traitor_name,
        "team_scores": game.team_scores,
        "winner_team": winner_team
    }
    
    game.chat_log.append({"type": "system", "text": f"ゲーム終了。{final_msg}"})
    emit('game_over', result_data, broadcast=True)
    emit_update_all()

@socketio.on('reset_game_ack')
def on_reset_ack():
    game.ack_game_over.add(request.sid)
    current_players_count = len([sid for sid in game.players if sid in socketio.server.eio.sockets])
    if len(game.ack_game_over) >= current_players_count and current_players_count > 0:
        game.reset_game()
        emit('reload_game', broadcast=True)

@socketio.on('disconnect')
def on_disconnect():
    print(f"Client disconnected: {request.sid}")
    # 復帰待ちのため削除しない

def emit_update_all():
    # クイズ情報も含めて送ることで、リロード時も表示を復元しやすくする
    current_quiz_data = None
    if game.current_quiz:
        current_quiz_data = {
            "q": game.current_quiz['q'],
            "u": game.current_quiz['u']
        }

    emit('update_status', {
        "status": game.status,
        "players": game.get_player_list(),
        "team_scores": game.team_scores,
        "settings": game.settings,
        "current_round": game.current_round,
        "traitor_sid": game.traitor_sid,
        "current_quiz_data": current_quiz_data
    }, broadcast=True)

if __name__ == '__main__':
    socketio.run(app, debug=True)