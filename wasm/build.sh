emcc wavelet.c -s WASM=2 -s EXPORT_NAME=CloudStacker -s ENVIRONMENT='web,worker' -s EXPORT_ES6=1 -s MODULARIZE=1 -s EXPORTED_FUNCTIONS='["_wavelet_sharpen", "_malloc", "_free"]' -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' -o wavelet_sharpen.js
cp wavelet_sharpen.js ../utils/
cp wavelet_sharpen.wasm ../utils/
cp wavelet_sharpen.wasm.js ../utils/
