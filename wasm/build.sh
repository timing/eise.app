# compile for main thread (this works)
# emcc wavelet.c -s WASM=2 -s ENVIRONMENT='web' -s EXPORT_ES6=1 -s MODULARIZE=1 -s EXPORTED_FUNCTIONS='["_wavelet_sharpen", "_malloc", "_free"]' -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' -o wavelet_sharpen.js

#compile for web worker (works!)
emcc wavelet.c -s WASM=2 -sALLOW_MEMORY_GROWTH -s ENVIRONMENT='web,worker' -s EXPORT_ES6=1 -s MODULARIZE=1 -s EXPORTED_FUNCTIONS='["_wavelet_sharpen", "_malloc", "_free"]' -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' -o wavelet_sharpen_worker.js

cp wavelet_sharpen* ../public/
