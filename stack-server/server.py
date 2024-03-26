from flask import Flask, request, jsonify, send_file, url_for
from flask_socketio import SocketIO, emit, join_room
from flask_cors import CORS
from werkzeug.utils import secure_filename
import shutil
import subprocess
import time
import os
import re
from queue import Queue
from threading import Thread, Semaphore

app = Flask(__name__)
# Flask originally does not have a max file size, but I kept getting http error 413 when uploading 249M. Here I'm trying to set it to 1G, but it does not work
# Maybe Flask's memory does not allow bigger files? I don't know
app.config['MAX_CONTENT_LENGTH'] = 1024 * 1024 * 1024
CORS(app)
socketio = SocketIO(app, cors_allowed_origins=['http://localhost:3001','https://cloud-stacker.pages.dev', 'https://eise.app'])

CONCURRENT_JOBS_LIMIT = 2

job_queue = Queue()
jobs_semaphore = Semaphore(CONCURRENT_JOBS_LIMIT)

def worker():
    while True:
        job_id = job_queue.get()
        process_file(job_id)
        job_queue.task_done()

# Start worker threads
for _ in range(CONCURRENT_JOBS_LIMIT):
    t = Thread(target=worker)
    t.daemon = True
    t.start()

def process_file(job_id):
    jobs_semaphore.acquire()
    try:
        command = "python ../../PlanetarySystemStacker/src/stack_frames.py uploads/" + job_id + "/*.png --output output/" + job_id + "-stacked.png"

        # Use Popen to execute the command and capture stdout in real-time
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, shell=True)

        # Read output line by line as it becomes available
        while True:
            output = process.stdout.readline()
            if output == '' and process.poll() is not None:
                break
            if output:
                print(output.strip())
                # Emit output line to the client via WebSocket
                socketio.emit('console_output', {'data': output.strip()}, room=job_id)

        socketio.emit('finished', {'image_url': 'output/' + job_id + "-stacked.png"}, room=job_id)

        shutil.rmtree("uploads/" + job_id + "/")

        send_image_blob(job_id)
    finally:
        jobs_semaphore.release()

def send_image_blob(job_id):
    image_path = 'output/' + job_id + "-stacked.png"
    try:
        with open(image_path, 'rb') as image_file:
            image_data = image_file.read()
            # Emit binary data to the client
            socketio.emit('image_data', image_data, room=job_id)

    except Exception as e:
        print("Error sending image blob:", e)

def clean_uuid(input_string):
    return re.sub(r'[^a-zA-Z0-9-]', '', input_string) 

@app.route('/images/list', methods=['GET'])
def list_images():
    directory = 'output/'
    files = os.listdir(directory)
    # Generate a URL for each file
    files_with_links = [{"url": url_for('send_image', file=file, _external=True)} for file in files if file.endswith('.png')]
    return jsonify(files_with_links)

@app.route('/images/show', methods=['GET'])
def show_images():
    directory = 'output/'
    files = os.listdir(directory)
    # Generate an <img> tag for each file
    img_tags = ''.join([f'<img width="300" src="{url_for("send_image", file=file, _external=True)}" />' for file in files if file.endswith('.png')])
    return f'<html><body>{img_tags}</body></html>'

@app.route('/image/stacked', methods=['GET'])
def send_image():
    image_path = 'output/' + secure_filename(request.args.get('file'))
    return send_file(image_path, mimetype='image/png')

@app.route('/upload', methods=['POST'])
def upload_file():

    files = request.files.getlist('imageFiles')

    job_id = clean_uuid(request.form.get('job_id'))

    print(job_id)
    print(files)
    if not files:
        return jsonify({'error': 'No files part'}), 400

    os.makedirs('uploads/' + job_id, exist_ok=True)

    for file in files:
        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        # Save each file
        filepath = os.path.join('uploads/' + job_id + '/', secure_filename(file.filename))
        file.save(filepath)

    job_queue.put(job_id)

    return jsonify({'message': 'Files received, stacking with PSS started'}), 202

@socketio.on('connect')
def handle_connect():
    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    print('Client disconnected')

@socketio.on('join')
def handle_join(data):
    room = data['room']
    join_room(room)
    emit('joined_room', {'message': f'Joined room {room}'}, room=room)

@app.errorhandler(413)
def request_entity_too_large(error):
    # Log the error and any other relevant information
    app.logger.error(f"413 Error: {error}")
    app.logger.error(f"Request path: {request.path}")
    app.logger.error(f"Request headers: {request.headers}")
    app.logger.error(f"Request content length: {request.content_length}")

    # Return a custom message or JSON response with debug information
    return jsonify({
        "error": "File too large",
        "message": "The file exceeds the maximum allowed size.",
        "debug": {
            "path": request.path,
            "content_length": request.content_length,
            "headers": dict(request.headers)
        }
    }), 413

if __name__ == '__main__':
    socketio.run(app, host='127.0.0.1', port='8080', debug=True)

