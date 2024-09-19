# About eise.app - Planetary Image Cloud Stacker
https://eise.app is the first web-based online planetary image stacking tool available in the solar system. The name is an ode to Eise Eisinga, a Frisian amateur astronomer who built a planetarium in his house. The main reason for developing yet another application for stacking is because of recent frustrations I had getting software running on my ARM based macbook. AutoStakkert4! didn't work in Wine, Planetary System Stacker by Rolf Hempel had python dependency issues, Lynkeos was slow with a very wonky UI and crashed continuously.

As a web developer, I saw an opportunity to make something simpler that works directly in your browser, regardless of your operating system. Initially, I thought about doing all the processing on a server, but that would be expensive and not scalable. Instead, eise.app does a chunk of the work in your browser using WebAssembly and WebWorkers, which turns out to be quite fast, and it just works (hopefully!) by navigating to this website!

# Currently eise.app works as follows:

- The astrophotographer selects a video file from their machine.
- FFmpeg.js is used to extract frames from the video file.
- eise.app starts ranking (up to 5k) frames of the video based on sharpness.
- The best 30% of frames are uploaded to a VPS powered by Digital Ocean.
- On the server a slightly modified Planetary System Stacker (by Rolf Hempel) is stacking all frames it receives.
- The server returns the stacked image to the browser.
- A very basic post processor is opened, providing Wavelets sharpening, some noise reduction and color alignment. Code is from OpenCV and a GIMP plugin compiled to WebAssembly using emscripten.
- In essence, eise.app is a blend of PSS's stacking capabilities combined with browser-based frame ranking and (post) processing.

I hope this web-app will improve your astrophotography workflow, or helps beginners not giving up when trying to set-up their software.

Happy Stacking,
Tijmen


# Running Eise.app locally
Clone this repo, `npm install`, `npm run dev` etc.


