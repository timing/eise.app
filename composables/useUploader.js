
import { io } from "socket.io-client";
import { useEventBus } from '@/composables/eventBus';

export function useUploader() {
    const { addLog, emit } = useEventBus();

    async function uploadFrames(bestFrames) {
        if (bestFrames.length === 0) {
            addLog('No frames to stack.');
            emit('stop-loading');
            return false;
        }

        const formData = new FormData();
        const imageIdentifier = Math.round(Math.random() * 10000);

        for (const s in bestFrames) {
            formData.append('imageFiles', new Blob(bestFrames[s].pngFile, { type: 'image/png' }), `${imageIdentifier}-${s}.png`);
        }

        const host = 'https://stack.eise.app';
        const jobId = crypto.randomUUID();
        formData.append('job_id', jobId);

        addLog(`FormData contains ${bestFrames.length} image files for upload.`);

        const wsUrl = host;
        const ws = io(wsUrl);

        ws.on('connect', () => {
            console.log('Connected to server');
            ws.emit('join', { room: jobId });
        });

        ws.on('console_output', (data) => {
            addLog(data.data);
            console.log('Console output', data);
        });

        ws.on('finished', (data) => {
            console.log('Processing finished, image URL:', data.image_url);
        });

        ws.on('image_data', (blob) => {
            addLog('Server side stack finished, loading post processing.');
            emit('stop-loading');
            emit('postProcessing', new Blob([blob]));
        });

        console.log('Uploader: Emitting set-caption for upload');
        emit('set-caption', 'Uploading frames for stacking');
        console.log('Uploader: Emitting update-loading(0) for upload start');
        emit('update-loading', 0);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${host}/upload`, true);

        xhr.upload.onprogress = function(event) {
            if (!event.lengthComputable) {
                return;
            }
            const progress = Math.round(event.loaded / event.total * 100);
            console.log('Uploader: Emitting update-loading', progress);
            emit('update-loading', progress);
        };

        xhr.onload = function() {
            if (xhr.status === 200 || xhr.status === 202) {
                const data = JSON.parse(xhr.responseText);
                emit('start-loading', 'Stacking frames on server');
                addLog(data.message);
                console.log(data);
            } else {
                const error = JSON.parse(xhr.responseText);
                addLog(error.message);
                console.error('Error:', error);
                emit('stop-loading');
                emit('upload-error', error.message);
            }
        };

        xhr.onerror = function() {
            const errorMessage = 'Error during the upload process.';
            addLog(errorMessage);
            console.error(errorMessage);
            emit('stop-loading');
            emit('upload-error', errorMessage);
        };

        xhr.send(formData);
    }

    return { uploadFrames };
}
