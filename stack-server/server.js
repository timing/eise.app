const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { StatusCodes } = require('http-status-codes');
const path = require('path');
const cors = require('cors');

const app = express();
const corsOptions = {
	origin: ['http://localhost:3001', 'https://cloud-stacker.pages.dev', 'https://eise.app']
}

app.use(cors(corsOptions));

const server = http.createServer(app);
const io = socketIo(server, {
	cors: {
		corsOptions
	}
});
const upload = multer({ dest: 'tmp/' });

const jobQueue = [];
let activeJobs = 0;
const CONCURRENT_JOBS_LIMIT = 2;

io.on('connection', (socket) => {
	console.log('Client connected');

	socket.on('join', (data) => {
		const { room } = data;
		socket.join(room);
		console.log(`A user joined room: ${room}`);
		socket.emit('joined_room', { message: `Joined room ${room}` });
	});

	socket.on('disconnect', () => {
		console.log('Client disconnected');
	});
});

const processFile = (jobId) => {
	activeJobs++;
	console.log(`Processing job: ${jobId}`);

	const pythonEnv = "../../stack-server/server-env/bin"
	const command = pythonEnv + '/python'; // get python executable from the right environment
	const args = ["../../PlanetarySystemStacker/src/stack_frames.py", `uploads/${jobId}/*.png`, "--output", `output/${jobId}-stacked.png`];

	const env = Object.create(process.env);
	env.PATH = path.join(__dirname, pythonEnv) + path.delimiter + env.PATH;

	const subprocess = spawn(command, args, {env: env, shell: true});

	subprocess.stdout.on('data', (data) => {
		console.log(`stdout: ${data}`);
		io.to(jobId).emit('console_output', { data: data.toString() });
	});

	subprocess.stderr.on('data', (data) => {
		console.error(`stderr: ${data}`);
	});

	subprocess.on('close', (code) => {
		console.log(`Process exited with code ${code}`);
		io.to(jobId).emit('finished', { image_url: `output/${jobId}-stacked.png` });
		sendImageBlob(jobId);

		fs.remove(`uploads/${jobId}`).catch(err => console.error(`Error removing directory: ${err}`));
		activeJobs--;
		processNextJob();
	});
};

const processNextJob = () => {
	if (activeJobs < CONCURRENT_JOBS_LIMIT && jobQueue.length > 0) {
		const jobId = jobQueue.shift(); // Dequeue the next job
		processFile(jobId);
	}
};

function sendImageBlob(jobId) {
	const imagePath = path.join(__dirname, 'output', `${jobId}-stacked.png`);

	fs.readFile(imagePath, (err, image_data) => {
		if (err) {
			console.error("Error sending image blob:", err);
			return;
		}

		// Send binary data directly
		io.to(jobId).emit('image_data', image_data);
	});
}

app.post('/upload', upload.array('imageFiles'), (req, res) => {
	const job_id = req.body.job_id; // Consider sanitizing this input.
	console.log(`Received job: ${job_id}`);

	if (!req.files || req.files.length === 0) {
		console.log('No files uploaded');
		return res.status(StatusCodes.BAD_REQUEST).json({ error: 'No files uploaded.' });
	}

	console.log('ensureDirSync', `uploads/${job_id}`, __dirname);
	fs.ensureDirSync(`uploads/${job_id}`);
	req.files.forEach(file => {
		try {
			fs.moveSync(file.path, `uploads/${job_id}/${file.originalname}`);
			console.log(`File moved to uploads/${job_id}/${file.originalname}`);
		} catch (error) {
			console.error('Error moving file:', error);
		}
	});
	
	jobQueue.push(job_id);
	processNextJob();

	res.status(StatusCodes.ACCEPTED).json({ message: 'File upload started.' });
});

// Endpoint to serve a specific stacked image
app.get('/image/stacked', (req, res) => {
	const fileName = path.basename(req.query.file).replace(/[^a-zA-Z0-9-_\.]/g, ''); // Ensure this input is sanitized
	const filePath = path.join(__dirname, 'output', fileName);
	return res.sendFile(filePath);
});

// Endpoint to display all stacked images
app.get('/images/show', (req, res) => {
	const outputDir = path.join(__dirname, 'output');
	fs.readdir(outputDir, (err, files) => {
		if (err) {
			console.error(err);
			return res.status(500).send('Server Error');
		}
		const imageTags = files.filter(file => file.endsWith('.png'))
							   .map(file => `<img width="300" src="/output/${file}" />`)
							   .join('');
		res.send(`<html><body>${imageTags}</body></html>`);
	});
});

const PORT = 8080; // Use your desired port
server.listen(PORT, '127.0.0.1', () => {
	console.log('Server listening on port ' + PORT);
	console.log(__dirname);
});

