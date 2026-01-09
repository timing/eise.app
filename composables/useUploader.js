
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
        const host = 'https://stack.eise.app';
        const jobId = crypto.randomUUID();
        formData.append('job_id', jobId);

        let validFrames = 0;
        let totalBytes = 0;
        for (let i = 0; i < bestFrames.length; i++) {
            const blob = bestFrames[i].pngFile?.[0];
            if (!blob || blob.size === 0) {
                console.warn(`Frame ${i}: Invalid or empty blob (type=${blob?.type}, size=${blob?.size})`);
                continue;
            }
            console.log(`Frame ${i}: blob type=${blob.type}, size=${blob.size} bytes`);
            totalBytes += blob.size;
            // Use the blob directly instead of wrapping it
            formData.append('imageFiles', blob, `${imageIdentifier}-${i}.png`);
            validFrames++;
        }

        if (validFrames === 0) {
            addLog('Error: No valid frame blobs to upload');
            emit('stop-loading');
            return false;
        }

        addLog(`Uploading ${validFrames} frames (${(totalBytes / 1024 / 1024).toFixed(1)} MB total)`);

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
        emit('set-caption', `Uploading ${validFrames} best frames`);
        // Reset progress and clear frame counter from previous step
        emit('update-loading', { progress: 0, current: 0, total: 0 });

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${host}/upload`, true);

        xhr.upload.onprogress = function(event) {
            if (!event.lengthComputable) {
                return;
            }
            const progress = Math.round(event.loaded / event.total * 100);
            // Keep frame counter at 0 during upload (only show percentage bar)
            emit('update-loading', { progress, current: 0, total: 0 });
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
