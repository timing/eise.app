/**
 * @license
 * Copyright 2019 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

// wasm2js.js - enough of a polyfill for the WebAssembly object so that we can load
// wasm2js code that way.

// Emit "var WebAssembly" if definitely using wasm2js. Otherwise, in MAYBE_WASM2JS
// mode, we can't use a "var" since it would prevent normal wasm from working.
/** @suppress{duplicate, const} */
var
WebAssembly = {
  // Note that we do not use closure quoting (this['buffer'], etc.) on these
  // functions, as they are just meant for internal use. In other words, this is
  // not a fully general polyfill.
  /** @constructor */
  Memory: function(opts) {
    this.buffer = new ArrayBuffer(opts['initial'] * 65536);
  },

  Module: function(binary) {
    // TODO: use the binary and info somehow - right now the wasm2js output is embedded in
    // the main JS
  },

  /** @constructor */
  Instance: function(module, info) {
    // TODO: use the module somehow - right now the wasm2js output is embedded in
    // the main JS
    // This will be replaced by the actual wasm2js code.
    this.exports = (
function instantiate(info) {
function Table(ret) {
  // grow method not included; table is not growable
  ret.set = function(i, func) {
    this[i] = func;
  };
  ret.get = function(i) {
    return this[i];
  };
  return ret;
}

  var bufferView;
  var base64ReverseLookup = new Uint8Array(123/*'z'+1*/);
  for (var i = 25; i >= 0; --i) {
    base64ReverseLookup[48+i] = 52+i; // '0-9'
    base64ReverseLookup[65+i] = i; // 'A-Z'
    base64ReverseLookup[97+i] = 26+i; // 'a-z'
  }
  base64ReverseLookup[43] = 62; // '+'
  base64ReverseLookup[47] = 63; // '/'
  /** @noinline Inlining this function would mean expanding the base64 string 4x times in the source code, which Closure seems to be happy to do. */
  function base64DecodeToExistingUint8Array(uint8Array, offset, b64) {
    var b1, b2, i = 0, j = offset, bLength = b64.length, end = offset + (bLength*3>>2) - (b64[bLength-2] == '=') - (b64[bLength-1] == '=');
    for (; i < bLength; i += 4) {
      b1 = base64ReverseLookup[b64.charCodeAt(i+1)];
      b2 = base64ReverseLookup[b64.charCodeAt(i+2)];
      uint8Array[j++] = base64ReverseLookup[b64.charCodeAt(i)] << 2 | b1 >> 4;
      if (j < end) uint8Array[j++] = b1 << 4 | b2 >> 2;
      if (j < end) uint8Array[j++] = b2 << 6 | base64ReverseLookup[b64.charCodeAt(i+3)];
    }
  }
function initActiveSegments(imports) {
  base64DecodeToExistingUint8Array(bufferView, 65536, "/oIrZUcVZ0AAAAAAAAA4QwAA+v5CLna/OjuevJr3DL29/f/////fPzxUVVVVVcU/kSsXz1VVpT8X0KRnERGBPwAAAAAAAMhC7zn6/kIu5j8kxIL/vb/OP7X0DNcIa6w/zFBG0quygz+EOk6b4NdVPwAAAAAAAAAAAAAAAAAA8D9uv4gaTzubPDUz+6k99u8/XdzYnBNgcbxhgHc+muzvP9FmhxB6XpC8hX9u6BXj7z8T9mc1UtKMPHSFFdOw2e8/+o75I4DOi7ze9t0pa9DvP2HI5mFO92A8yJt1GEXH7z+Z0zNb5KOQPIPzxso+vu8/bXuDXaaalzwPiflsWLXvP/zv/ZIatY4890dyK5Ks7z/RnC9wPb4+PKLR0zLso+8/C26QiTQDarwb0/6vZpvvPw69LypSVpW8UVsS0AGT7z9V6k6M74BQvMwxbMC9iu8/FvTVuSPJkbzgLamumoLvP69VXOnj04A8UY6lyJh67z9Ik6XqFRuAvHtRfTy4cu8/PTLeVfAfj7zqjYw4+WrvP79TEz+MiYs8dctv61tj7z8m6xF2nNmWvNRcBITgW+8/YC86PvfsmjyquWgxh1TvP504hsuC54+8Hdn8IlBN7z+Nw6ZEQW+KPNaMYog7Ru8/fQTksAV6gDyW3H2RST/vP5SoqOP9jpY8OGJ1bno47z99SHTyGF6HPD+msk/OMe8/8ucfmCtHgDzdfOJlRSvvP14IcT97uJa8gWP14d8k7z8xqwlt4feCPOHeH/WdHu8/+r9vGpshPbyQ2drQfxjvP7QKDHKCN4s8CwPkpoUS7z+Py86JkhRuPFYvPqmvDO8/tquwTXVNgzwVtzEK/gbvP0x0rOIBQoY8MdhM/HAB7z9K+NNdOd2PPP8WZLII/O4/BFuOO4Cjhrzxn5JfxfbuP2hQS8ztSpK8y6k6N6fx7j+OLVEb+AeZvGbYBW2u7O4/0jaUPujRcbz3n+U02+fuPxUbzrMZGZm85agTwy3j7j9tTCqnSJ+FPCI0Ekym3u4/imkoemASk7wcgKwERdruP1uJF0iPp1i8Ki73IQrW7j8bmklnmyx8vJeoUNn10e4/EazCYO1jQzwtiWFgCM7uP+9kBjsJZpY8VwAd7UHK7j95A6Ha4cxuPNA8wbWixu4/MBIPP47/kzze09fwKsPuP7CvervOkHY8Jyo21dq/7j934FTrvR2TPA3d/ZmyvO4/jqNxADSUj7ynLJ12srnuP0mjk9zM3oe8QmbPotq27j9fOA+9xt54vIJPnVYrtO4/9lx77EYShrwPkl3KpLHuP47X/RgFNZM82ie1Nkev7j8Fm4ovt5h7PP3Hl9QSre4/CVQc4uFjkDwpVEjdB6vuP+rGGVCFxzQ8t0ZZiiap7j81wGQr5jKUPEghrRVvp+4/n3aZYUrkjLwJ3Ha54aXuP6hN7zvFM4y8hVU6sH6k7j+u6SuJeFOEvCDDzDRGo+4/WFhWeN3Ok7wlIlWCOKLuP2QZfoCqEFc8c6lM1FWh7j8oIl6/77OTvM07f2aeoO4/grk0h60Sary/2gt1EqDuP+6pbbjvZ2O8LxplPLKf7j9RiOBUPdyAvISUUfl9n+4/zz5afmQfeLx0X+zodZ/uP7B9i8BK7oa8dIGlSJqf7j+K5lUeMhmGvMlnQlbrn+4/09QJXsuckDw/Xd5PaaDuPx2lTbncMnu8hwHrcxSh7j9rwGdU/eyUPDLBMAHtoe4/VWzWq+HrZTxiTs8286LuP0LPsy/FoYi8Eho+VCek7j80NzvxtmmTvBPOTJmJpe4/Hv8ZOoRegLytxyNGGqfuP25XcthQ1JS87ZJEm9mo7j8Aig5bZ62QPJlmitnHqu4/tOrwwS+3jTzboCpC5azuP//nxZxgtmW8jES1FjKv7j9EX/NZg/Z7PDZ3FZmuse4/gz0epx8Jk7zG/5ELW7TuPykebIu4qV285cXNsDe37j9ZuZB8+SNsvA9SyMtEuu4/qvn0IkNDkrxQTt6fgr3uP0uOZtdsyoW8ugfKcPHA7j8nzpEr/K9xPJDwo4KRxO4/u3MK4TXSbTwjI+MZY8juP2MiYiIExYe8ZeVde2bM7j/VMeLjhhyLPDMtSuyb0O4/Fbu809G7kbxdJT6yA9XuP9Ix7pwxzJA8WLMwE57Z7j+zWnNuhGmEPL/9eVVr3u4/tJ2Ol83fgrx689O/a+PuP4czy5J3Gow8rdNamZ/o7j/62dFKj3uQvGa2jSkH7u4/uq7cVtnDVbz7FU+4ovPuP0D2pj0OpJC8OlnljXL57j80k6049NZovEde+/J2/+4/NYpYa+LukbxKBqEwsAXvP83dXwrX/3Q80sFLkB4M7z+smJL6+72RvAke11vCEu8/swyvMK5uczycUoXdmxnvP5T9n1wy4448etD/X6sg7z+sWQnRj+CEPEvRVy7xJ+8/ZxpOOK/NYzy15waUbS/vP2gZkmwsa2c8aZDv3CA37z/StcyDGIqAvPrDXVULP+8/b/r/P12tj7x8iQdKLUfvP0mpdTiuDZC88okNCIdP7z+nBz2mhaN0PIek+9wYWO8/DyJAIJ6RgryYg8kW42DvP6ySwdVQWo48hTLbA+Zp7z9LawGsWTqEPGC0AfMhc+8/Hz60ByHVgrxfm3szl3zvP8kNRzu5Kom8KaH1FEaG7z/TiDpgBLZ0PPY/i+cukO8/cXKdUezFgzyDTMf7UZrvP/CR048S94+82pCkoq+k7z99dCPimK6NvPFnji1Ir+8/CCCqQbzDjjwnWmHuG7rvPzLrqcOUK4Q8l7prNyvF7z/uhdExqWSKPEBFblt20O8/7eM75Lo3jrwUvpyt/dvvP53NkU07iXc82JCegcHn7z+JzGBBwQVTPPFxjyvC8+8/");
  base64DecodeToExistingUint8Array(bufferView, 67696, "gAoBAA==");
}

  var scratchBuffer = new ArrayBuffer(16);
  var i32ScratchView = new Int32Array(scratchBuffer);
  var f32ScratchView = new Float32Array(scratchBuffer);
  var f64ScratchView = new Float64Array(scratchBuffer);
  
  function wasm2js_scratch_load_i32(index) {
    return i32ScratchView[index];
  }
      
  function wasm2js_scratch_store_i32(index, value) {
    i32ScratchView[index] = value;
  }
      
  function wasm2js_scratch_load_f64() {
    return f64ScratchView[0];
  }
      
  function wasm2js_scratch_store_f64(value) {
    f64ScratchView[0] = value;
  }
      
function asmFunc(imports) {
 var buffer = new ArrayBuffer(16777216);
 var HEAP8 = new Int8Array(buffer);
 var HEAP16 = new Int16Array(buffer);
 var HEAP32 = new Int32Array(buffer);
 var HEAPU8 = new Uint8Array(buffer);
 var HEAPU16 = new Uint16Array(buffer);
 var HEAPU32 = new Uint32Array(buffer);
 var HEAPF32 = new Float32Array(buffer);
 var HEAPF64 = new Float64Array(buffer);
 var Math_imul = Math.imul;
 var Math_fround = Math.fround;
 var Math_abs = Math.abs;
 var Math_clz32 = Math.clz32;
 var Math_min = Math.min;
 var Math_max = Math.max;
 var Math_floor = Math.floor;
 var Math_ceil = Math.ceil;
 var Math_trunc = Math.trunc;
 var Math_sqrt = Math.sqrt;
 var env = imports.env;
 var fimport$0 = env.emscripten_resize_heap;
 var global$0 = 65536;
 var global$2 = 0;
 var global$3 = 0;
 var i64toi32_i32$HIGH_BITS = 0;
 // EMSCRIPTEN_START_FUNCS
;
 function $0() {
  $27();
 }
 
 function $1($0_1, $1_1, $2_1, $3_1, $4_1) {
  $0_1 = $0_1 | 0;
  $1_1 = $1_1 | 0;
  $2_1 = $2_1 | 0;
  $3_1 = $3_1 | 0;
  $4_1 = $4_1 | 0;
  var $7_1 = 0, $131 = Math_fround(0), $137 = Math_fround(0), $143 = Math_fround(0);
  $7_1 = global$0 - 32 | 0;
  HEAP32[($7_1 + 28 | 0) >> 2] = $0_1;
  HEAP32[($7_1 + 24 | 0) >> 2] = $1_1;
  HEAP32[($7_1 + 20 | 0) >> 2] = $2_1;
  HEAP32[($7_1 + 16 | 0) >> 2] = $3_1;
  HEAP32[($7_1 + 12 | 0) >> 2] = $4_1;
  HEAP32[($7_1 + 8 | 0) >> 2] = 0;
  label$1 : {
   label$2 : while (1) {
    if (!((HEAP32[($7_1 + 8 | 0) >> 2] | 0 | 0) < (HEAP32[($7_1 + 12 | 0) >> 2] | 0 | 0) & 1 | 0)) {
     break label$1
    }
    $131 = Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, HEAP32[($7_1 + 8 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]);
    HEAPF32[((HEAP32[($7_1 + 28 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 8 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] = Math_fround(Math_fround(Math_fround($131 + $131) + Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, (HEAP32[($7_1 + 12 | 0) >> 2] | 0) - (HEAP32[($7_1 + 8 | 0) >> 2] | 0) | 0) << 2 | 0) | 0) >> 2])) + Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, (HEAP32[($7_1 + 8 | 0) >> 2] | 0) + (HEAP32[($7_1 + 12 | 0) >> 2] | 0) | 0) << 2 | 0) | 0) >> 2]));
    HEAP32[($7_1 + 8 | 0) >> 2] = (HEAP32[($7_1 + 8 | 0) >> 2] | 0) + 1 | 0;
    continue label$2;
   };
  }
  label$3 : {
   label$4 : while (1) {
    if (!(((HEAP32[($7_1 + 8 | 0) >> 2] | 0) + (HEAP32[($7_1 + 12 | 0) >> 2] | 0) | 0 | 0) < (HEAP32[($7_1 + 16 | 0) >> 2] | 0 | 0) & 1 | 0)) {
     break label$3
    }
    $137 = Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, HEAP32[($7_1 + 8 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]);
    HEAPF32[((HEAP32[($7_1 + 28 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 8 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] = Math_fround(Math_fround(Math_fround($137 + $137) + Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, (HEAP32[($7_1 + 8 | 0) >> 2] | 0) - (HEAP32[($7_1 + 12 | 0) >> 2] | 0) | 0) << 2 | 0) | 0) >> 2])) + Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, (HEAP32[($7_1 + 8 | 0) >> 2] | 0) + (HEAP32[($7_1 + 12 | 0) >> 2] | 0) | 0) << 2 | 0) | 0) >> 2]));
    HEAP32[($7_1 + 8 | 0) >> 2] = (HEAP32[($7_1 + 8 | 0) >> 2] | 0) + 1 | 0;
    continue label$4;
   };
  }
  label$5 : {
   label$6 : while (1) {
    if (!((HEAP32[($7_1 + 8 | 0) >> 2] | 0 | 0) < (HEAP32[($7_1 + 16 | 0) >> 2] | 0 | 0) & 1 | 0)) {
     break label$5
    }
    $143 = Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, HEAP32[($7_1 + 8 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]);
    HEAPF32[((HEAP32[($7_1 + 28 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 8 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] = Math_fround(Math_fround(Math_fround($143 + $143) + Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, (HEAP32[($7_1 + 8 | 0) >> 2] | 0) - (HEAP32[($7_1 + 12 | 0) >> 2] | 0) | 0) << 2 | 0) | 0) >> 2])) + Math_fround(HEAPF32[((HEAP32[($7_1 + 24 | 0) >> 2] | 0) + (Math_imul(HEAP32[($7_1 + 20 | 0) >> 2] | 0, (((HEAP32[($7_1 + 16 | 0) >> 2] | 0) << 1 | 0) - 2 | 0) - ((HEAP32[($7_1 + 8 | 0) >> 2] | 0) + (HEAP32[($7_1 + 12 | 0) >> 2] | 0) | 0) | 0) << 2 | 0) | 0) >> 2]));
    HEAP32[($7_1 + 8 | 0) >> 2] = (HEAP32[($7_1 + 8 | 0) >> 2] | 0) + 1 | 0;
    continue label$6;
   };
  }
  return;
 }
 
 function $2($0_1, $1_1, $2_1, $3_1, $4_1) {
  $0_1 = $0_1 | 0;
  $1_1 = $1_1 | 0;
  $2_1 = $2_1 | 0;
  $3_1 = +$3_1;
  $4_1 = +$4_1;
  var $7_1 = 0, $68 = 0, $368 = 0.0, $232 = 0, $244 = 0, $262 = 0, $20_1 = 0;
  $7_1 = global$0 - 80 | 0;
  global$0 = $7_1;
  HEAP32[($7_1 + 76 | 0) >> 2] = $0_1;
  HEAP32[($7_1 + 72 | 0) >> 2] = $1_1;
  HEAP32[($7_1 + 68 | 0) >> 2] = $2_1;
  HEAPF64[($7_1 + 56 | 0) >> 3] = $3_1;
  HEAPF64[($7_1 + 48 | 0) >> 3] = $4_1;
  HEAP32[($7_1 + 8 | 0) >> 2] = Math_imul(HEAP32[($7_1 + 72 | 0) >> 2] | 0, HEAP32[($7_1 + 68 | 0) >> 2] | 0);
  HEAP32[($7_1 + 24 | 0) >> 2] = 0;
  label$1 : {
   label$2 : {
    label$3 : while (1) {
     if (!((HEAP32[($7_1 + 24 | 0) >> 2] | 0) >>> 0 < 3 >>> 0 & 1 | 0)) {
      break label$2
     }
     $20_1 = $15((HEAP32[($7_1 + 8 | 0) >> 2] | 0) << 2 | 0 | 0) | 0;
     HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] = $20_1;
     label$4 : {
      if (!((HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0 | 0) == (0 | 0) & 1 | 0)) {
       break label$4
      }
      break label$1;
     }
     HEAP32[($7_1 + 24 | 0) >> 2] = (HEAP32[($7_1 + 24 | 0) >> 2] | 0) + 1 | 0;
     continue label$3;
    };
   }
   HEAP32[($7_1 + 24 | 0) >> 2] = 0;
   label$5 : {
    label$6 : while (1) {
     if (!((HEAP32[($7_1 + 24 | 0) >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 8 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
      break label$5
     }
     HEAPF32[((HEAP32[($7_1 + 36 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] = Math_fround(HEAPF32[((HEAP32[($7_1 + 76 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]);
     HEAP32[($7_1 + 24 | 0) >> 2] = (HEAP32[($7_1 + 24 | 0) >> 2] | 0) + 1 | 0;
     continue label$6;
    };
   }
   label$7 : {
    label$8 : {
     if (!((HEAP32[($7_1 + 72 | 0) >> 2] | 0) >>> 0 > (HEAP32[($7_1 + 68 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
      break label$8
     }
     $68 = HEAP32[($7_1 + 72 | 0) >> 2] | 0;
     break label$7;
    }
    $68 = HEAP32[($7_1 + 68 | 0) >> 2] | 0;
   }
   HEAP32[($7_1 + 32 | 0) >> 2] = $15($68 << 2 | 0 | 0) | 0;
   HEAP32[($7_1 + 12 | 0) >> 2] = 0;
   HEAP32[($7_1 + 20 | 0) >> 2] = 0;
   label$9 : {
    label$10 : while (1) {
     if (!((HEAP32[($7_1 + 20 | 0) >> 2] | 0) >>> 0 < 5 >>> 0 & 1 | 0)) {
      break label$9
     }
     HEAP32[($7_1 + 16 | 0) >> 2] = ((HEAP32[($7_1 + 20 | 0) >> 2] | 0) & 1 | 0) + 1 | 0;
     HEAP32[$7_1 >> 2] = 0;
     label$11 : {
      label$12 : while (1) {
       if (!((HEAP32[$7_1 >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 68 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
        break label$11
       }
       $1(HEAP32[($7_1 + 32 | 0) >> 2] | 0 | 0, (HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 12 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + (Math_imul(HEAP32[$7_1 >> 2] | 0, HEAP32[($7_1 + 72 | 0) >> 2] | 0) << 2 | 0) | 0 | 0, 1 | 0, HEAP32[($7_1 + 72 | 0) >> 2] | 0 | 0, 1 << (HEAP32[($7_1 + 20 | 0) >> 2] | 0) | 0 | 0);
       HEAP32[($7_1 + 4 | 0) >> 2] = 0;
       label$13 : {
        label$14 : while (1) {
         if (!((HEAP32[($7_1 + 4 | 0) >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 72 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
          break label$13
         }
         HEAPF32[((HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 16 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((Math_imul(HEAP32[$7_1 >> 2] | 0, HEAP32[($7_1 + 72 | 0) >> 2] | 0) + (HEAP32[($7_1 + 4 | 0) >> 2] | 0) | 0) << 2 | 0) | 0) >> 2] = Math_fround(+Math_fround(HEAPF32[((HEAP32[($7_1 + 32 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 4 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]) * .25);
         HEAP32[($7_1 + 4 | 0) >> 2] = (HEAP32[($7_1 + 4 | 0) >> 2] | 0) + 1 | 0;
         continue label$14;
        };
       }
       HEAP32[$7_1 >> 2] = (HEAP32[$7_1 >> 2] | 0) + 1 | 0;
       continue label$12;
      };
     }
     HEAP32[($7_1 + 4 | 0) >> 2] = 0;
     label$15 : {
      label$16 : while (1) {
       if (!((HEAP32[($7_1 + 4 | 0) >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 72 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
        break label$15
       }
       $1(HEAP32[($7_1 + 32 | 0) >> 2] | 0 | 0, (HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 16 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((HEAP32[($7_1 + 4 | 0) >> 2] | 0) << 2 | 0) | 0 | 0, HEAP32[($7_1 + 72 | 0) >> 2] | 0 | 0, HEAP32[($7_1 + 68 | 0) >> 2] | 0 | 0, 1 << (HEAP32[($7_1 + 20 | 0) >> 2] | 0) | 0 | 0);
       HEAP32[$7_1 >> 2] = 0;
       label$17 : {
        label$18 : while (1) {
         if (!((HEAP32[$7_1 >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 68 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
          break label$17
         }
         HEAPF32[((HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 16 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((Math_imul(HEAP32[$7_1 >> 2] | 0, HEAP32[($7_1 + 72 | 0) >> 2] | 0) + (HEAP32[($7_1 + 4 | 0) >> 2] | 0) | 0) << 2 | 0) | 0) >> 2] = Math_fround(+Math_fround(HEAPF32[((HEAP32[($7_1 + 32 | 0) >> 2] | 0) + ((HEAP32[$7_1 >> 2] | 0) << 2 | 0) | 0) >> 2]) * .25);
         HEAP32[$7_1 >> 2] = (HEAP32[$7_1 >> 2] | 0) + 1 | 0;
         continue label$18;
        };
       }
       HEAP32[($7_1 + 4 | 0) >> 2] = (HEAP32[($7_1 + 4 | 0) >> 2] | 0) + 1 | 0;
       continue label$16;
      };
     }
     $368 = +((HEAP32[($7_1 + 20 | 0) >> 2] | 0) >>> 0) - +HEAPF64[($7_1 + 48 | 0) >> 3];
     HEAPF32[($7_1 + 28 | 0) >> 2] = Math_fround(+HEAPF64[($7_1 + 56 | 0) >> 3] * +$7(+($368 * $368 / -1.5)) + 1.0);
     HEAP32[($7_1 + 24 | 0) >> 2] = 0;
     label$19 : {
      label$20 : while (1) {
       if (!((HEAP32[($7_1 + 24 | 0) >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 8 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
        break label$19
       }
       $232 = (HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 12 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0;
       HEAPF32[$232 >> 2] = Math_fround(Math_fround(HEAPF32[$232 >> 2]) - Math_fround(HEAPF32[((HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 16 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]));
       $244 = (HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 12 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0;
       HEAPF32[$244 >> 2] = Math_fround(Math_fround(HEAPF32[$244 >> 2]) * Math_fround(HEAPF32[($7_1 + 28 | 0) >> 2]));
       label$21 : {
        if (!(HEAP32[($7_1 + 12 | 0) >> 2] | 0)) {
         break label$21
        }
        $262 = (HEAP32[($7_1 + 36 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0;
        HEAPF32[$262 >> 2] = Math_fround(Math_fround(HEAPF32[$262 >> 2]) + Math_fround(HEAPF32[((HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 12 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]));
       }
       HEAP32[($7_1 + 24 | 0) >> 2] = (HEAP32[($7_1 + 24 | 0) >> 2] | 0) + 1 | 0;
       continue label$20;
      };
     }
     HEAP32[($7_1 + 12 | 0) >> 2] = HEAP32[($7_1 + 16 | 0) >> 2] | 0;
     HEAP32[($7_1 + 20 | 0) >> 2] = (HEAP32[($7_1 + 20 | 0) >> 2] | 0) + 1 | 0;
     continue label$10;
    };
   }
   HEAP32[($7_1 + 24 | 0) >> 2] = 0;
   label$22 : {
    label$23 : while (1) {
     if (!((HEAP32[($7_1 + 24 | 0) >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 8 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
      break label$22
     }
     HEAPF32[((HEAP32[($7_1 + 36 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] = Math_fround(Math_fround(HEAPF32[((HEAP32[($7_1 + 36 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]) + Math_fround(HEAPF32[((HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 16 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]));
     HEAP32[($7_1 + 24 | 0) >> 2] = (HEAP32[($7_1 + 24 | 0) >> 2] | 0) + 1 | 0;
     continue label$23;
    };
   }
   HEAP32[($7_1 + 24 | 0) >> 2] = 0;
   label$24 : {
    label$25 : while (1) {
     if (!((HEAP32[($7_1 + 24 | 0) >> 2] | 0) >>> 0 < (HEAP32[($7_1 + 8 | 0) >> 2] | 0) >>> 0 & 1 | 0)) {
      break label$24
     }
     HEAPF32[((HEAP32[($7_1 + 76 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] = Math_fround(HEAPF32[((HEAP32[($7_1 + 36 | 0) >> 2] | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2]);
     HEAP32[($7_1 + 24 | 0) >> 2] = (HEAP32[($7_1 + 24 | 0) >> 2] | 0) + 1 | 0;
     continue label$25;
    };
   }
   HEAP32[($7_1 + 24 | 0) >> 2] = 0;
   label$26 : {
    label$27 : while (1) {
     if (!((HEAP32[($7_1 + 24 | 0) >> 2] | 0) >>> 0 < 3 >>> 0 & 1 | 0)) {
      break label$26
     }
     $17(HEAP32[(($7_1 + 36 | 0) + ((HEAP32[($7_1 + 24 | 0) >> 2] | 0) << 2 | 0) | 0) >> 2] | 0 | 0);
     HEAP32[($7_1 + 24 | 0) >> 2] = (HEAP32[($7_1 + 24 | 0) >> 2] | 0) + 1 | 0;
     continue label$27;
    };
   }
   $17(HEAP32[($7_1 + 32 | 0) >> 2] | 0 | 0);
  }
  global$0 = $7_1 + 80 | 0;
  return;
 }
 
 function $3($0_1, $1_1) {
  $0_1 = $0_1 | 0;
  $1_1 = +$1_1;
  return +(+$4(+($0_1 ? -$1_1 : $1_1)) * $1_1);
 }
 
 function $4($0_1) {
  $0_1 = +$0_1;
  var $1_1 = 0;
  $1_1 = global$0 - 16 | 0;
  HEAPF64[($1_1 + 8 | 0) >> 3] = $0_1;
  return +(+HEAPF64[($1_1 + 8 | 0) >> 3]);
 }
 
 function $5($0_1) {
  $0_1 = $0_1 | 0;
  return +(+$3($0_1 | 0, +(1.2882297539194267e-231)));
 }
 
 function $6($0_1) {
  $0_1 = $0_1 | 0;
  return +(+$3($0_1 | 0, +(3105036184601417870297958.0e207)));
 }
 
 function $7($0_1) {
  $0_1 = +$0_1;
  var $3_1 = 0.0, i64toi32_i32$2 = 0, i64toi32_i32$3 = 0, i64toi32_i32$1 = 0, i64toi32_i32$0 = 0, i64toi32_i32$4 = 0, $1_1 = 0, $2_1 = 0, $5_1 = 0, i64toi32_i32$5 = 0, $5$hi = 0, $20_1 = 0, $21_1 = 0, $22_1 = 0, $4_1 = 0.0, $23_1 = 0, $6$hi = 0, $69 = 0.0, $76 = 0.0, $92 = 0, $92$hi = 0, $94$hi = 0, $6_1 = 0;
  label$1 : {
   label$2 : {
    label$3 : {
     $1_1 = ($8(+$0_1) | 0) & 2047 | 0;
     $2_1 = $8(+(5.551115123125783e-17)) | 0;
     if (($1_1 - $2_1 | 0) >>> 0 >= (($8(+(512.0)) | 0) - $2_1 | 0) >>> 0) {
      break label$3
     }
     $2_1 = $1_1;
     break label$2;
    }
    label$4 : {
     if ($1_1 >>> 0 >= $2_1 >>> 0) {
      break label$4
     }
     return +($0_1 + 1.0);
    }
    $2_1 = 0;
    if ($1_1 >>> 0 < ($8(+(1024.0)) | 0) >>> 0) {
     break label$2
    }
    $3_1 = 0.0;
    wasm2js_scratch_store_f64(+$0_1);
    i64toi32_i32$0 = wasm2js_scratch_load_i32(1 | 0) | 0;
    $5_1 = wasm2js_scratch_load_i32(0 | 0) | 0;
    $5$hi = i64toi32_i32$0;
    i64toi32_i32$2 = $5_1;
    i64toi32_i32$1 = -1048576;
    i64toi32_i32$3 = 0;
    if ((i64toi32_i32$2 | 0) == (i64toi32_i32$3 | 0) & (i64toi32_i32$0 | 0) == (i64toi32_i32$1 | 0) | 0) {
     break label$1
    }
    label$5 : {
     if ($1_1 >>> 0 < ($8(+(Infinity)) | 0) >>> 0) {
      break label$5
     }
     return +($0_1 + 1.0);
    }
    label$6 : {
     i64toi32_i32$2 = $5$hi;
     i64toi32_i32$3 = $5_1;
     i64toi32_i32$0 = -1;
     i64toi32_i32$1 = -1;
     if ((i64toi32_i32$2 | 0) > (i64toi32_i32$0 | 0)) {
      $20_1 = 1
     } else {
      if ((i64toi32_i32$2 | 0) >= (i64toi32_i32$0 | 0)) {
       if (i64toi32_i32$3 >>> 0 <= i64toi32_i32$1 >>> 0) {
        $21_1 = 0
       } else {
        $21_1 = 1
       }
       $22_1 = $21_1;
      } else {
       $22_1 = 0
      }
      $20_1 = $22_1;
     }
     if ($20_1) {
      break label$6
     }
     return +(+$5(0 | 0));
    }
    return +(+$6(0 | 0));
   }
   $3_1 = +HEAPF64[(0 + 65544 | 0) >> 3];
   $4_1 = +HEAPF64[(0 + 65536 | 0) >> 3] * $0_1 + $3_1;
   $3_1 = $4_1 - $3_1;
   $0_1 = $3_1 * +HEAPF64[(0 + 65560 | 0) >> 3] + ($3_1 * +HEAPF64[(0 + 65552 | 0) >> 3] + $0_1);
   $3_1 = $0_1 * $0_1;
   $69 = $3_1 * $3_1 * ($0_1 * +HEAPF64[(0 + 65592 | 0) >> 3] + +HEAPF64[(0 + 65584 | 0) >> 3]);
   $76 = $3_1 * ($0_1 * +HEAPF64[(0 + 65576 | 0) >> 3] + +HEAPF64[(0 + 65568 | 0) >> 3]);
   wasm2js_scratch_store_f64(+$4_1);
   i64toi32_i32$3 = wasm2js_scratch_load_i32(1 | 0) | 0;
   $5_1 = wasm2js_scratch_load_i32(0 | 0) | 0;
   $5$hi = i64toi32_i32$3;
   $1_1 = ($5_1 << 4 | 0) & 2032 | 0;
   $0_1 = $69 + ($76 + (+HEAPF64[($1_1 + 65648 | 0) >> 3] + $0_1));
   i64toi32_i32$1 = $1_1 + 65656 | 0;
   i64toi32_i32$3 = HEAP32[i64toi32_i32$1 >> 2] | 0;
   i64toi32_i32$2 = HEAP32[(i64toi32_i32$1 + 4 | 0) >> 2] | 0;
   $92 = i64toi32_i32$3;
   $92$hi = i64toi32_i32$2;
   i64toi32_i32$2 = $5$hi;
   i64toi32_i32$1 = $5_1;
   i64toi32_i32$3 = 0;
   i64toi32_i32$0 = 45;
   i64toi32_i32$4 = i64toi32_i32$0 & 31 | 0;
   if (32 >>> 0 <= (i64toi32_i32$0 & 63 | 0) >>> 0) {
    i64toi32_i32$3 = i64toi32_i32$1 << i64toi32_i32$4 | 0;
    $23_1 = 0;
   } else {
    i64toi32_i32$3 = ((1 << i64toi32_i32$4 | 0) - 1 | 0) & (i64toi32_i32$1 >>> (32 - i64toi32_i32$4 | 0) | 0) | 0 | (i64toi32_i32$2 << i64toi32_i32$4 | 0) | 0;
    $23_1 = i64toi32_i32$1 << i64toi32_i32$4 | 0;
   }
   $94$hi = i64toi32_i32$3;
   i64toi32_i32$3 = $92$hi;
   i64toi32_i32$2 = $92;
   i64toi32_i32$1 = $94$hi;
   i64toi32_i32$0 = $23_1;
   i64toi32_i32$4 = i64toi32_i32$2 + i64toi32_i32$0 | 0;
   i64toi32_i32$5 = i64toi32_i32$3 + i64toi32_i32$1 | 0;
   if (i64toi32_i32$4 >>> 0 < i64toi32_i32$0 >>> 0) {
    i64toi32_i32$5 = i64toi32_i32$5 + 1 | 0
   }
   $6_1 = i64toi32_i32$4;
   $6$hi = i64toi32_i32$5;
   label$7 : {
    if ($2_1) {
     break label$7
    }
    i64toi32_i32$5 = $5$hi;
    i64toi32_i32$5 = $6$hi;
    i64toi32_i32$2 = $5$hi;
    return +(+$9(+$0_1, i64toi32_i32$4 | 0, i64toi32_i32$5 | 0, $5_1 | 0, i64toi32_i32$2 | 0));
   }
   i64toi32_i32$2 = $6$hi;
   wasm2js_scratch_store_i32(0 | 0, $6_1 | 0);
   wasm2js_scratch_store_i32(1 | 0, i64toi32_i32$2 | 0);
   $3_1 = +wasm2js_scratch_load_f64();
   $3_1 = $3_1 * $0_1 + $3_1;
  }
  return +$3_1;
 }
 
 function $8($0_1) {
  $0_1 = +$0_1;
  var i64toi32_i32$4 = 0, i64toi32_i32$0 = 0, i64toi32_i32$1 = 0, i64toi32_i32$3 = 0, $6_1 = 0, i64toi32_i32$2 = 0;
  wasm2js_scratch_store_f64(+$0_1);
  i64toi32_i32$0 = wasm2js_scratch_load_i32(1 | 0) | 0;
  i64toi32_i32$2 = wasm2js_scratch_load_i32(0 | 0) | 0;
  i64toi32_i32$1 = 0;
  i64toi32_i32$3 = 52;
  i64toi32_i32$4 = i64toi32_i32$3 & 31 | 0;
  if (32 >>> 0 <= (i64toi32_i32$3 & 63 | 0) >>> 0) {
   i64toi32_i32$1 = 0;
   $6_1 = i64toi32_i32$0 >>> i64toi32_i32$4 | 0;
  } else {
   i64toi32_i32$1 = i64toi32_i32$0 >>> i64toi32_i32$4 | 0;
   $6_1 = (((1 << i64toi32_i32$4 | 0) - 1 | 0) & i64toi32_i32$0 | 0) << (32 - i64toi32_i32$4 | 0) | 0 | (i64toi32_i32$2 >>> i64toi32_i32$4 | 0) | 0;
  }
  return $6_1 | 0;
 }
 
 function $9($0_1, $1_1, $1$hi, $2_1, $2$hi) {
  $0_1 = +$0_1;
  $1_1 = $1_1 | 0;
  $1$hi = $1$hi | 0;
  $2_1 = $2_1 | 0;
  $2$hi = $2$hi | 0;
  var i64toi32_i32$2 = 0, i64toi32_i32$1 = 0, i64toi32_i32$0 = 0, i64toi32_i32$3 = 0, i64toi32_i32$4 = 0, $3_1 = 0.0, i64toi32_i32$5 = 0, $4_1 = 0.0, $5_1 = 0.0;
  label$1 : {
   i64toi32_i32$0 = $2$hi;
   i64toi32_i32$2 = $2_1;
   i64toi32_i32$1 = 0;
   i64toi32_i32$3 = -2147483648;
   i64toi32_i32$1 = i64toi32_i32$0 & i64toi32_i32$1 | 0;
   i64toi32_i32$0 = i64toi32_i32$2 & i64toi32_i32$3 | 0;
   i64toi32_i32$2 = 0;
   i64toi32_i32$3 = 0;
   if ((i64toi32_i32$0 | 0) != (i64toi32_i32$3 | 0) | (i64toi32_i32$1 | 0) != (i64toi32_i32$2 | 0) | 0) {
    break label$1
   }
   i64toi32_i32$0 = $1$hi;
   i64toi32_i32$3 = $1_1;
   i64toi32_i32$1 = -1058013184;
   i64toi32_i32$2 = 0;
   i64toi32_i32$4 = i64toi32_i32$3 + i64toi32_i32$2 | 0;
   i64toi32_i32$5 = i64toi32_i32$0 + i64toi32_i32$1 | 0;
   if (i64toi32_i32$4 >>> 0 < i64toi32_i32$2 >>> 0) {
    i64toi32_i32$5 = i64toi32_i32$5 + 1 | 0
   }
   wasm2js_scratch_store_i32(0 | 0, i64toi32_i32$4 | 0);
   wasm2js_scratch_store_i32(1 | 0, i64toi32_i32$5 | 0);
   $3_1 = +wasm2js_scratch_load_f64();
   return +(($3_1 * $0_1 + $3_1) * 5486124068793688683255936.0e279);
  }
  label$2 : {
   i64toi32_i32$5 = $1$hi;
   i64toi32_i32$0 = $1_1;
   i64toi32_i32$3 = 1071644672;
   i64toi32_i32$2 = 0;
   i64toi32_i32$1 = i64toi32_i32$0 + i64toi32_i32$2 | 0;
   i64toi32_i32$4 = i64toi32_i32$5 + i64toi32_i32$3 | 0;
   if (i64toi32_i32$1 >>> 0 < i64toi32_i32$2 >>> 0) {
    i64toi32_i32$4 = i64toi32_i32$4 + 1 | 0
   }
   wasm2js_scratch_store_i32(0 | 0, i64toi32_i32$1 | 0);
   wasm2js_scratch_store_i32(1 | 0, i64toi32_i32$4 | 0);
   $3_1 = +wasm2js_scratch_load_f64();
   $4_1 = $3_1 * $0_1;
   $0_1 = $4_1 + $3_1;
   if (!($0_1 < 1.0)) {
    break label$2
   }
   $11(+(+$10() * 2.2250738585072014e-308));
   $5_1 = $0_1 + 1.0;
   $0_1 = $5_1 + ($4_1 + ($3_1 - $0_1) + ($0_1 + (1.0 - $5_1))) + -1.0;
   $0_1 = $0_1 == 0.0 ? 0.0 : $0_1;
  }
  return +($0_1 * 2.2250738585072014e-308);
 }
 
 function $10() {
  var $0_1 = 0;
  $0_1 = global$0 - 16 | 0;
  HEAP32[($0_1 + 8 | 0) >> 2] = 0;
  HEAP32[($0_1 + 12 | 0) >> 2] = 1048576;
  return +(+HEAPF64[($0_1 + 8 | 0) >> 3]);
 }
 
 function $11($0_1) {
  $0_1 = +$0_1;
  HEAPF64[((global$0 - 16 | 0) + 8 | 0) >> 3] = $0_1;
 }
 
 function $12() {
  return __wasm_memory_size() << 16 | 0 | 0;
 }
 
 function $13() {
  return 67700 | 0;
 }
 
 function $14($0_1) {
  $0_1 = $0_1 | 0;
  var $1_1 = 0, $2_1 = 0;
  $1_1 = HEAP32[(0 + 67696 | 0) >> 2] | 0;
  $2_1 = ($0_1 + 7 | 0) & -8 | 0;
  $0_1 = $1_1 + $2_1 | 0;
  label$1 : {
   label$2 : {
    label$3 : {
     if (!$2_1) {
      break label$3
     }
     if ($0_1 >>> 0 <= $1_1 >>> 0) {
      break label$2
     }
    }
    if ($0_1 >>> 0 <= ($12() | 0) >>> 0) {
     break label$1
    }
    if (fimport$0($0_1 | 0) | 0) {
     break label$1
    }
   }
   HEAP32[($13() | 0) >> 2] = 48;
   return -1 | 0;
  }
  HEAP32[(0 + 67696 | 0) >> 2] = $0_1;
  return $1_1 | 0;
 }
 
 function $15($0_1) {
  $0_1 = $0_1 | 0;
  var $5_1 = 0, $4_1 = 0, $7_1 = 0, $8_1 = 0, $3_1 = 0, $2_1 = 0, $6_1 = 0, $10_1 = 0, $11_1 = 0, i64toi32_i32$0 = 0, i64toi32_i32$1 = 0, i64toi32_i32$2 = 0, $1_1 = 0, $9_1 = 0, $79 = 0, $183 = 0, $782 = 0, $784 = 0;
  $1_1 = global$0 - 16 | 0;
  global$0 = $1_1;
  label$1 : {
   label$2 : {
    label$3 : {
     label$4 : {
      label$5 : {
       label$6 : {
        label$7 : {
         label$8 : {
          label$9 : {
           label$10 : {
            label$11 : {
             if ($0_1 >>> 0 > 244 >>> 0) {
              break label$11
             }
             label$12 : {
              $2_1 = HEAP32[(0 + 67704 | 0) >> 2] | 0;
              $3_1 = $0_1 >>> 0 < 11 >>> 0 ? 16 : ($0_1 + 11 | 0) & 504 | 0;
              $4_1 = $3_1 >>> 3 | 0;
              $0_1 = $2_1 >>> $4_1 | 0;
              if (!($0_1 & 3 | 0)) {
               break label$12
              }
              label$13 : {
               label$14 : {
                $3_1 = (($0_1 ^ -1 | 0) & 1 | 0) + $4_1 | 0;
                $4_1 = $3_1 << 3 | 0;
                $0_1 = $4_1 + 67744 | 0;
                $4_1 = HEAP32[($4_1 + 67752 | 0) >> 2] | 0;
                $5_1 = HEAP32[($4_1 + 8 | 0) >> 2] | 0;
                if (($0_1 | 0) != ($5_1 | 0)) {
                 break label$14
                }
                HEAP32[(0 + 67704 | 0) >> 2] = $2_1 & (__wasm_rotl_i32(-2 | 0, $3_1 | 0) | 0) | 0;
                break label$13;
               }
               HEAP32[($5_1 + 12 | 0) >> 2] = $0_1;
               HEAP32[($0_1 + 8 | 0) >> 2] = $5_1;
              }
              $0_1 = $4_1 + 8 | 0;
              $3_1 = $3_1 << 3 | 0;
              HEAP32[($4_1 + 4 | 0) >> 2] = $3_1 | 3 | 0;
              $4_1 = $4_1 + $3_1 | 0;
              HEAP32[($4_1 + 4 | 0) >> 2] = HEAP32[($4_1 + 4 | 0) >> 2] | 0 | 1 | 0;
              break label$1;
             }
             $6_1 = HEAP32[(0 + 67712 | 0) >> 2] | 0;
             if ($3_1 >>> 0 <= $6_1 >>> 0) {
              break label$10
             }
             label$15 : {
              if (!$0_1) {
               break label$15
              }
              label$16 : {
               label$17 : {
                $79 = $0_1 << $4_1 | 0;
                $0_1 = 2 << $4_1 | 0;
                $4_1 = __wasm_ctz_i32($79 & ($0_1 | (0 - $0_1 | 0) | 0) | 0 | 0) | 0;
                $0_1 = $4_1 << 3 | 0;
                $5_1 = $0_1 + 67744 | 0;
                $0_1 = HEAP32[($0_1 + 67752 | 0) >> 2] | 0;
                $7_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
                if (($5_1 | 0) != ($7_1 | 0)) {
                 break label$17
                }
                $2_1 = $2_1 & (__wasm_rotl_i32(-2 | 0, $4_1 | 0) | 0) | 0;
                HEAP32[(0 + 67704 | 0) >> 2] = $2_1;
                break label$16;
               }
               HEAP32[($7_1 + 12 | 0) >> 2] = $5_1;
               HEAP32[($5_1 + 8 | 0) >> 2] = $7_1;
              }
              HEAP32[($0_1 + 4 | 0) >> 2] = $3_1 | 3 | 0;
              $7_1 = $0_1 + $3_1 | 0;
              $4_1 = $4_1 << 3 | 0;
              $3_1 = $4_1 - $3_1 | 0;
              HEAP32[($7_1 + 4 | 0) >> 2] = $3_1 | 1 | 0;
              HEAP32[($0_1 + $4_1 | 0) >> 2] = $3_1;
              label$18 : {
               if (!$6_1) {
                break label$18
               }
               $5_1 = ($6_1 & -8 | 0) + 67744 | 0;
               $4_1 = HEAP32[(0 + 67724 | 0) >> 2] | 0;
               label$19 : {
                label$20 : {
                 $8_1 = 1 << ($6_1 >>> 3 | 0) | 0;
                 if ($2_1 & $8_1 | 0) {
                  break label$20
                 }
                 HEAP32[(0 + 67704 | 0) >> 2] = $2_1 | $8_1 | 0;
                 $8_1 = $5_1;
                 break label$19;
                }
                $8_1 = HEAP32[($5_1 + 8 | 0) >> 2] | 0;
               }
               HEAP32[($5_1 + 8 | 0) >> 2] = $4_1;
               HEAP32[($8_1 + 12 | 0) >> 2] = $4_1;
               HEAP32[($4_1 + 12 | 0) >> 2] = $5_1;
               HEAP32[($4_1 + 8 | 0) >> 2] = $8_1;
              }
              $0_1 = $0_1 + 8 | 0;
              HEAP32[(0 + 67724 | 0) >> 2] = $7_1;
              HEAP32[(0 + 67712 | 0) >> 2] = $3_1;
              break label$1;
             }
             $9_1 = HEAP32[(0 + 67708 | 0) >> 2] | 0;
             if (!$9_1) {
              break label$10
             }
             $7_1 = HEAP32[(((__wasm_ctz_i32($9_1 | 0) | 0) << 2 | 0) + 68008 | 0) >> 2] | 0;
             $4_1 = ((HEAP32[($7_1 + 4 | 0) >> 2] | 0) & -8 | 0) - $3_1 | 0;
             $5_1 = $7_1;
             label$21 : {
              label$22 : while (1) {
               label$23 : {
                $0_1 = HEAP32[($5_1 + 16 | 0) >> 2] | 0;
                if ($0_1) {
                 break label$23
                }
                $0_1 = HEAP32[($5_1 + 20 | 0) >> 2] | 0;
                if (!$0_1) {
                 break label$21
                }
               }
               $5_1 = ((HEAP32[($0_1 + 4 | 0) >> 2] | 0) & -8 | 0) - $3_1 | 0;
               $183 = $5_1;
               $5_1 = $5_1 >>> 0 < $4_1 >>> 0;
               $4_1 = $5_1 ? $183 : $4_1;
               $7_1 = $5_1 ? $0_1 : $7_1;
               $5_1 = $0_1;
               continue label$22;
              };
             }
             $10_1 = HEAP32[($7_1 + 24 | 0) >> 2] | 0;
             label$24 : {
              $0_1 = HEAP32[($7_1 + 12 | 0) >> 2] | 0;
              if (($0_1 | 0) == ($7_1 | 0)) {
               break label$24
              }
              $5_1 = HEAP32[($7_1 + 8 | 0) >> 2] | 0;
              HEAP32[(0 + 67720 | 0) >> 2] | 0;
              HEAP32[($5_1 + 12 | 0) >> 2] = $0_1;
              HEAP32[($0_1 + 8 | 0) >> 2] = $5_1;
              break label$2;
             }
             label$25 : {
              label$26 : {
               $5_1 = HEAP32[($7_1 + 20 | 0) >> 2] | 0;
               if (!$5_1) {
                break label$26
               }
               $8_1 = $7_1 + 20 | 0;
               break label$25;
              }
              $5_1 = HEAP32[($7_1 + 16 | 0) >> 2] | 0;
              if (!$5_1) {
               break label$9
              }
              $8_1 = $7_1 + 16 | 0;
             }
             label$27 : while (1) {
              $11_1 = $8_1;
              $0_1 = $5_1;
              $8_1 = $0_1 + 20 | 0;
              $5_1 = HEAP32[($0_1 + 20 | 0) >> 2] | 0;
              if ($5_1) {
               continue label$27
              }
              $8_1 = $0_1 + 16 | 0;
              $5_1 = HEAP32[($0_1 + 16 | 0) >> 2] | 0;
              if ($5_1) {
               continue label$27
              }
              break label$27;
             };
             HEAP32[$11_1 >> 2] = 0;
             break label$2;
            }
            $3_1 = -1;
            if ($0_1 >>> 0 > -65 >>> 0) {
             break label$10
            }
            $0_1 = $0_1 + 11 | 0;
            $3_1 = $0_1 & -8 | 0;
            $10_1 = HEAP32[(0 + 67708 | 0) >> 2] | 0;
            if (!$10_1) {
             break label$10
            }
            $6_1 = 0;
            label$28 : {
             if ($3_1 >>> 0 < 256 >>> 0) {
              break label$28
             }
             $6_1 = 31;
             if ($3_1 >>> 0 > 16777215 >>> 0) {
              break label$28
             }
             $0_1 = Math_clz32($0_1 >>> 8 | 0);
             $6_1 = ((($3_1 >>> (38 - $0_1 | 0) | 0) & 1 | 0) - ($0_1 << 1 | 0) | 0) + 62 | 0;
            }
            $4_1 = 0 - $3_1 | 0;
            label$29 : {
             label$30 : {
              label$31 : {
               label$32 : {
                $5_1 = HEAP32[(($6_1 << 2 | 0) + 68008 | 0) >> 2] | 0;
                if ($5_1) {
                 break label$32
                }
                $0_1 = 0;
                $8_1 = 0;
                break label$31;
               }
               $0_1 = 0;
               $7_1 = $3_1 << (($6_1 | 0) == (31 | 0) ? 0 : 25 - ($6_1 >>> 1 | 0) | 0) | 0;
               $8_1 = 0;
               label$33 : while (1) {
                label$34 : {
                 $2_1 = ((HEAP32[($5_1 + 4 | 0) >> 2] | 0) & -8 | 0) - $3_1 | 0;
                 if ($2_1 >>> 0 >= $4_1 >>> 0) {
                  break label$34
                 }
                 $4_1 = $2_1;
                 $8_1 = $5_1;
                 if ($4_1) {
                  break label$34
                 }
                 $4_1 = 0;
                 $8_1 = $5_1;
                 $0_1 = $5_1;
                 break label$30;
                }
                $2_1 = HEAP32[($5_1 + 20 | 0) >> 2] | 0;
                $11_1 = HEAP32[(($5_1 + (($7_1 >>> 29 | 0) & 4 | 0) | 0) + 16 | 0) >> 2] | 0;
                $0_1 = $2_1 ? (($2_1 | 0) == ($11_1 | 0) ? $0_1 : $2_1) : $0_1;
                $7_1 = $7_1 << 1 | 0;
                $5_1 = $11_1;
                if ($5_1) {
                 continue label$33
                }
                break label$33;
               };
              }
              label$35 : {
               if ($0_1 | $8_1 | 0) {
                break label$35
               }
               $8_1 = 0;
               $0_1 = 2 << $6_1 | 0;
               $0_1 = ($0_1 | (0 - $0_1 | 0) | 0) & $10_1 | 0;
               if (!$0_1) {
                break label$10
               }
               $0_1 = HEAP32[(((__wasm_ctz_i32($0_1 | 0) | 0) << 2 | 0) + 68008 | 0) >> 2] | 0;
              }
              if (!$0_1) {
               break label$29
              }
             }
             label$36 : while (1) {
              $2_1 = ((HEAP32[($0_1 + 4 | 0) >> 2] | 0) & -8 | 0) - $3_1 | 0;
              $7_1 = $2_1 >>> 0 < $4_1 >>> 0;
              label$37 : {
               $5_1 = HEAP32[($0_1 + 16 | 0) >> 2] | 0;
               if ($5_1) {
                break label$37
               }
               $5_1 = HEAP32[($0_1 + 20 | 0) >> 2] | 0;
              }
              $4_1 = $7_1 ? $2_1 : $4_1;
              $8_1 = $7_1 ? $0_1 : $8_1;
              $0_1 = $5_1;
              if ($0_1) {
               continue label$36
              }
              break label$36;
             };
            }
            if (!$8_1) {
             break label$10
            }
            if ($4_1 >>> 0 >= ((HEAP32[(0 + 67712 | 0) >> 2] | 0) - $3_1 | 0) >>> 0) {
             break label$10
            }
            $11_1 = HEAP32[($8_1 + 24 | 0) >> 2] | 0;
            label$38 : {
             $0_1 = HEAP32[($8_1 + 12 | 0) >> 2] | 0;
             if (($0_1 | 0) == ($8_1 | 0)) {
              break label$38
             }
             $5_1 = HEAP32[($8_1 + 8 | 0) >> 2] | 0;
             HEAP32[(0 + 67720 | 0) >> 2] | 0;
             HEAP32[($5_1 + 12 | 0) >> 2] = $0_1;
             HEAP32[($0_1 + 8 | 0) >> 2] = $5_1;
             break label$3;
            }
            label$39 : {
             label$40 : {
              $5_1 = HEAP32[($8_1 + 20 | 0) >> 2] | 0;
              if (!$5_1) {
               break label$40
              }
              $7_1 = $8_1 + 20 | 0;
              break label$39;
             }
             $5_1 = HEAP32[($8_1 + 16 | 0) >> 2] | 0;
             if (!$5_1) {
              break label$8
             }
             $7_1 = $8_1 + 16 | 0;
            }
            label$41 : while (1) {
             $2_1 = $7_1;
             $0_1 = $5_1;
             $7_1 = $0_1 + 20 | 0;
             $5_1 = HEAP32[($0_1 + 20 | 0) >> 2] | 0;
             if ($5_1) {
              continue label$41
             }
             $7_1 = $0_1 + 16 | 0;
             $5_1 = HEAP32[($0_1 + 16 | 0) >> 2] | 0;
             if ($5_1) {
              continue label$41
             }
             break label$41;
            };
            HEAP32[$2_1 >> 2] = 0;
            break label$3;
           }
           label$42 : {
            $0_1 = HEAP32[(0 + 67712 | 0) >> 2] | 0;
            if ($0_1 >>> 0 < $3_1 >>> 0) {
             break label$42
            }
            $4_1 = HEAP32[(0 + 67724 | 0) >> 2] | 0;
            label$43 : {
             label$44 : {
              $5_1 = $0_1 - $3_1 | 0;
              if ($5_1 >>> 0 < 16 >>> 0) {
               break label$44
              }
              $7_1 = $4_1 + $3_1 | 0;
              HEAP32[($7_1 + 4 | 0) >> 2] = $5_1 | 1 | 0;
              HEAP32[($4_1 + $0_1 | 0) >> 2] = $5_1;
              HEAP32[($4_1 + 4 | 0) >> 2] = $3_1 | 3 | 0;
              break label$43;
             }
             HEAP32[($4_1 + 4 | 0) >> 2] = $0_1 | 3 | 0;
             $0_1 = $4_1 + $0_1 | 0;
             HEAP32[($0_1 + 4 | 0) >> 2] = HEAP32[($0_1 + 4 | 0) >> 2] | 0 | 1 | 0;
             $7_1 = 0;
             $5_1 = 0;
            }
            HEAP32[(0 + 67712 | 0) >> 2] = $5_1;
            HEAP32[(0 + 67724 | 0) >> 2] = $7_1;
            $0_1 = $4_1 + 8 | 0;
            break label$1;
           }
           label$45 : {
            $7_1 = HEAP32[(0 + 67716 | 0) >> 2] | 0;
            if ($7_1 >>> 0 <= $3_1 >>> 0) {
             break label$45
            }
            $4_1 = $7_1 - $3_1 | 0;
            HEAP32[(0 + 67716 | 0) >> 2] = $4_1;
            $0_1 = HEAP32[(0 + 67728 | 0) >> 2] | 0;
            $5_1 = $0_1 + $3_1 | 0;
            HEAP32[(0 + 67728 | 0) >> 2] = $5_1;
            HEAP32[($5_1 + 4 | 0) >> 2] = $4_1 | 1 | 0;
            HEAP32[($0_1 + 4 | 0) >> 2] = $3_1 | 3 | 0;
            $0_1 = $0_1 + 8 | 0;
            break label$1;
           }
           label$46 : {
            label$47 : {
             if (!(HEAP32[(0 + 68176 | 0) >> 2] | 0)) {
              break label$47
             }
             $4_1 = HEAP32[(0 + 68184 | 0) >> 2] | 0;
             break label$46;
            }
            i64toi32_i32$1 = 0;
            i64toi32_i32$0 = -1;
            HEAP32[(i64toi32_i32$1 + 68188 | 0) >> 2] = -1;
            HEAP32[(i64toi32_i32$1 + 68192 | 0) >> 2] = i64toi32_i32$0;
            i64toi32_i32$1 = 0;
            i64toi32_i32$0 = 4096;
            HEAP32[(i64toi32_i32$1 + 68180 | 0) >> 2] = 4096;
            HEAP32[(i64toi32_i32$1 + 68184 | 0) >> 2] = i64toi32_i32$0;
            HEAP32[(0 + 68176 | 0) >> 2] = (($1_1 + 12 | 0) & -16 | 0) ^ 1431655768 | 0;
            HEAP32[(0 + 68196 | 0) >> 2] = 0;
            HEAP32[(0 + 68148 | 0) >> 2] = 0;
            $4_1 = 4096;
           }
           $0_1 = 0;
           $6_1 = $3_1 + 47 | 0;
           $2_1 = $4_1 + $6_1 | 0;
           $11_1 = 0 - $4_1 | 0;
           $8_1 = $2_1 & $11_1 | 0;
           if ($8_1 >>> 0 <= $3_1 >>> 0) {
            break label$1
           }
           $0_1 = 0;
           label$48 : {
            $4_1 = HEAP32[(0 + 68144 | 0) >> 2] | 0;
            if (!$4_1) {
             break label$48
            }
            $5_1 = HEAP32[(0 + 68136 | 0) >> 2] | 0;
            $10_1 = $5_1 + $8_1 | 0;
            if ($10_1 >>> 0 <= $5_1 >>> 0) {
             break label$1
            }
            if ($10_1 >>> 0 > $4_1 >>> 0) {
             break label$1
            }
           }
           label$49 : {
            label$50 : {
             if ((HEAPU8[(0 + 68148 | 0) >> 0] | 0) & 4 | 0) {
              break label$50
             }
             label$51 : {
              label$52 : {
               label$53 : {
                label$54 : {
                 label$55 : {
                  $4_1 = HEAP32[(0 + 67728 | 0) >> 2] | 0;
                  if (!$4_1) {
                   break label$55
                  }
                  $0_1 = 68152;
                  label$56 : while (1) {
                   label$57 : {
                    $5_1 = HEAP32[$0_1 >> 2] | 0;
                    if ($5_1 >>> 0 > $4_1 >>> 0) {
                     break label$57
                    }
                    if (($5_1 + (HEAP32[($0_1 + 4 | 0) >> 2] | 0) | 0) >>> 0 > $4_1 >>> 0) {
                     break label$54
                    }
                   }
                   $0_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
                   if ($0_1) {
                    continue label$56
                   }
                   break label$56;
                  };
                 }
                 $7_1 = $14(0 | 0) | 0;
                 if (($7_1 | 0) == (-1 | 0)) {
                  break label$51
                 }
                 $2_1 = $8_1;
                 label$58 : {
                  $0_1 = HEAP32[(0 + 68180 | 0) >> 2] | 0;
                  $4_1 = $0_1 + -1 | 0;
                  if (!($4_1 & $7_1 | 0)) {
                   break label$58
                  }
                  $2_1 = ($8_1 - $7_1 | 0) + (($4_1 + $7_1 | 0) & (0 - $0_1 | 0) | 0) | 0;
                 }
                 if ($2_1 >>> 0 <= $3_1 >>> 0) {
                  break label$51
                 }
                 label$59 : {
                  $0_1 = HEAP32[(0 + 68144 | 0) >> 2] | 0;
                  if (!$0_1) {
                   break label$59
                  }
                  $4_1 = HEAP32[(0 + 68136 | 0) >> 2] | 0;
                  $5_1 = $4_1 + $2_1 | 0;
                  if ($5_1 >>> 0 <= $4_1 >>> 0) {
                   break label$51
                  }
                  if ($5_1 >>> 0 > $0_1 >>> 0) {
                   break label$51
                  }
                 }
                 $0_1 = $14($2_1 | 0) | 0;
                 if (($0_1 | 0) != ($7_1 | 0)) {
                  break label$53
                 }
                 break label$49;
                }
                $2_1 = ($2_1 - $7_1 | 0) & $11_1 | 0;
                $7_1 = $14($2_1 | 0) | 0;
                if (($7_1 | 0) == ((HEAP32[$0_1 >> 2] | 0) + (HEAP32[($0_1 + 4 | 0) >> 2] | 0) | 0 | 0)) {
                 break label$52
                }
                $0_1 = $7_1;
               }
               if (($0_1 | 0) == (-1 | 0)) {
                break label$51
               }
               label$60 : {
                if ($2_1 >>> 0 < ($3_1 + 48 | 0) >>> 0) {
                 break label$60
                }
                $7_1 = $0_1;
                break label$49;
               }
               $4_1 = HEAP32[(0 + 68184 | 0) >> 2] | 0;
               $4_1 = (($6_1 - $2_1 | 0) + $4_1 | 0) & (0 - $4_1 | 0) | 0;
               if (($14($4_1 | 0) | 0 | 0) == (-1 | 0)) {
                break label$51
               }
               $2_1 = $4_1 + $2_1 | 0;
               $7_1 = $0_1;
               break label$49;
              }
              if (($7_1 | 0) != (-1 | 0)) {
               break label$49
              }
             }
             HEAP32[(0 + 68148 | 0) >> 2] = HEAP32[(0 + 68148 | 0) >> 2] | 0 | 4 | 0;
            }
            $7_1 = $14($8_1 | 0) | 0;
            $0_1 = $14(0 | 0) | 0;
            if (($7_1 | 0) == (-1 | 0)) {
             break label$5
            }
            if (($0_1 | 0) == (-1 | 0)) {
             break label$5
            }
            if ($7_1 >>> 0 >= $0_1 >>> 0) {
             break label$5
            }
            $2_1 = $0_1 - $7_1 | 0;
            if ($2_1 >>> 0 <= ($3_1 + 40 | 0) >>> 0) {
             break label$5
            }
           }
           $0_1 = (HEAP32[(0 + 68136 | 0) >> 2] | 0) + $2_1 | 0;
           HEAP32[(0 + 68136 | 0) >> 2] = $0_1;
           label$61 : {
            if ($0_1 >>> 0 <= (HEAP32[(0 + 68140 | 0) >> 2] | 0) >>> 0) {
             break label$61
            }
            HEAP32[(0 + 68140 | 0) >> 2] = $0_1;
           }
           label$62 : {
            label$63 : {
             $4_1 = HEAP32[(0 + 67728 | 0) >> 2] | 0;
             if (!$4_1) {
              break label$63
             }
             $0_1 = 68152;
             label$64 : while (1) {
              $5_1 = HEAP32[$0_1 >> 2] | 0;
              $8_1 = HEAP32[($0_1 + 4 | 0) >> 2] | 0;
              if (($7_1 | 0) == ($5_1 + $8_1 | 0 | 0)) {
               break label$62
              }
              $0_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
              if ($0_1) {
               continue label$64
              }
              break label$7;
             };
            }
            label$65 : {
             label$66 : {
              $0_1 = HEAP32[(0 + 67720 | 0) >> 2] | 0;
              if (!$0_1) {
               break label$66
              }
              if ($7_1 >>> 0 >= $0_1 >>> 0) {
               break label$65
              }
             }
             HEAP32[(0 + 67720 | 0) >> 2] = $7_1;
            }
            $0_1 = 0;
            HEAP32[(0 + 68156 | 0) >> 2] = $2_1;
            HEAP32[(0 + 68152 | 0) >> 2] = $7_1;
            HEAP32[(0 + 67736 | 0) >> 2] = -1;
            HEAP32[(0 + 67740 | 0) >> 2] = HEAP32[(0 + 68176 | 0) >> 2] | 0;
            HEAP32[(0 + 68164 | 0) >> 2] = 0;
            label$67 : while (1) {
             $4_1 = $0_1 << 3 | 0;
             $5_1 = $4_1 + 67744 | 0;
             HEAP32[($4_1 + 67752 | 0) >> 2] = $5_1;
             HEAP32[($4_1 + 67756 | 0) >> 2] = $5_1;
             $0_1 = $0_1 + 1 | 0;
             if (($0_1 | 0) != (32 | 0)) {
              continue label$67
             }
             break label$67;
            };
            $0_1 = $2_1 + -40 | 0;
            $4_1 = (-8 - $7_1 | 0) & 7 | 0;
            $5_1 = $0_1 - $4_1 | 0;
            HEAP32[(0 + 67716 | 0) >> 2] = $5_1;
            $4_1 = $7_1 + $4_1 | 0;
            HEAP32[(0 + 67728 | 0) >> 2] = $4_1;
            HEAP32[($4_1 + 4 | 0) >> 2] = $5_1 | 1 | 0;
            HEAP32[(($7_1 + $0_1 | 0) + 4 | 0) >> 2] = 40;
            HEAP32[(0 + 67732 | 0) >> 2] = HEAP32[(0 + 68192 | 0) >> 2] | 0;
            break label$6;
           }
           if ($4_1 >>> 0 >= $7_1 >>> 0) {
            break label$7
           }
           if ($4_1 >>> 0 < $5_1 >>> 0) {
            break label$7
           }
           if ((HEAP32[($0_1 + 12 | 0) >> 2] | 0) & 8 | 0) {
            break label$7
           }
           HEAP32[($0_1 + 4 | 0) >> 2] = $8_1 + $2_1 | 0;
           $0_1 = (-8 - $4_1 | 0) & 7 | 0;
           $5_1 = $4_1 + $0_1 | 0;
           HEAP32[(0 + 67728 | 0) >> 2] = $5_1;
           $7_1 = (HEAP32[(0 + 67716 | 0) >> 2] | 0) + $2_1 | 0;
           $0_1 = $7_1 - $0_1 | 0;
           HEAP32[(0 + 67716 | 0) >> 2] = $0_1;
           HEAP32[($5_1 + 4 | 0) >> 2] = $0_1 | 1 | 0;
           HEAP32[(($4_1 + $7_1 | 0) + 4 | 0) >> 2] = 40;
           HEAP32[(0 + 67732 | 0) >> 2] = HEAP32[(0 + 68192 | 0) >> 2] | 0;
           break label$6;
          }
          $0_1 = 0;
          break label$2;
         }
         $0_1 = 0;
         break label$3;
        }
        label$68 : {
         if ($7_1 >>> 0 >= (HEAP32[(0 + 67720 | 0) >> 2] | 0) >>> 0) {
          break label$68
         }
         HEAP32[(0 + 67720 | 0) >> 2] = $7_1;
        }
        $5_1 = $7_1 + $2_1 | 0;
        $0_1 = 68152;
        label$69 : {
         label$70 : {
          label$71 : while (1) {
           if ((HEAP32[$0_1 >> 2] | 0 | 0) == ($5_1 | 0)) {
            break label$70
           }
           $0_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
           if ($0_1) {
            continue label$71
           }
           break label$69;
          };
         }
         if (!((HEAPU8[($0_1 + 12 | 0) >> 0] | 0) & 8 | 0)) {
          break label$4
         }
        }
        $0_1 = 68152;
        label$72 : {
         label$73 : while (1) {
          label$74 : {
           $5_1 = HEAP32[$0_1 >> 2] | 0;
           if ($5_1 >>> 0 > $4_1 >>> 0) {
            break label$74
           }
           $5_1 = $5_1 + (HEAP32[($0_1 + 4 | 0) >> 2] | 0) | 0;
           if ($5_1 >>> 0 > $4_1 >>> 0) {
            break label$72
           }
          }
          $0_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
          continue label$73;
         };
        }
        $0_1 = $2_1 + -40 | 0;
        $8_1 = (-8 - $7_1 | 0) & 7 | 0;
        $11_1 = $0_1 - $8_1 | 0;
        HEAP32[(0 + 67716 | 0) >> 2] = $11_1;
        $8_1 = $7_1 + $8_1 | 0;
        HEAP32[(0 + 67728 | 0) >> 2] = $8_1;
        HEAP32[($8_1 + 4 | 0) >> 2] = $11_1 | 1 | 0;
        HEAP32[(($7_1 + $0_1 | 0) + 4 | 0) >> 2] = 40;
        HEAP32[(0 + 67732 | 0) >> 2] = HEAP32[(0 + 68192 | 0) >> 2] | 0;
        $0_1 = ($5_1 + ((39 - $5_1 | 0) & 7 | 0) | 0) + -47 | 0;
        $8_1 = $0_1 >>> 0 < ($4_1 + 16 | 0) >>> 0 ? $4_1 : $0_1;
        HEAP32[($8_1 + 4 | 0) >> 2] = 27;
        i64toi32_i32$2 = 0;
        i64toi32_i32$0 = HEAP32[(i64toi32_i32$2 + 68160 | 0) >> 2] | 0;
        i64toi32_i32$1 = HEAP32[(i64toi32_i32$2 + 68164 | 0) >> 2] | 0;
        $782 = i64toi32_i32$0;
        i64toi32_i32$0 = $8_1 + 16 | 0;
        HEAP32[i64toi32_i32$0 >> 2] = $782;
        HEAP32[(i64toi32_i32$0 + 4 | 0) >> 2] = i64toi32_i32$1;
        i64toi32_i32$2 = 0;
        i64toi32_i32$1 = HEAP32[(i64toi32_i32$2 + 68152 | 0) >> 2] | 0;
        i64toi32_i32$0 = HEAP32[(i64toi32_i32$2 + 68156 | 0) >> 2] | 0;
        $784 = i64toi32_i32$1;
        i64toi32_i32$1 = $8_1;
        HEAP32[($8_1 + 8 | 0) >> 2] = $784;
        HEAP32[($8_1 + 12 | 0) >> 2] = i64toi32_i32$0;
        HEAP32[(0 + 68160 | 0) >> 2] = $8_1 + 8 | 0;
        HEAP32[(0 + 68156 | 0) >> 2] = $2_1;
        HEAP32[(0 + 68152 | 0) >> 2] = $7_1;
        HEAP32[(0 + 68164 | 0) >> 2] = 0;
        $0_1 = $8_1 + 24 | 0;
        label$75 : while (1) {
         HEAP32[($0_1 + 4 | 0) >> 2] = 7;
         $7_1 = $0_1 + 8 | 0;
         $0_1 = $0_1 + 4 | 0;
         if ($7_1 >>> 0 < $5_1 >>> 0) {
          continue label$75
         }
         break label$75;
        };
        if (($8_1 | 0) == ($4_1 | 0)) {
         break label$6
        }
        HEAP32[($8_1 + 4 | 0) >> 2] = (HEAP32[($8_1 + 4 | 0) >> 2] | 0) & -2 | 0;
        $7_1 = $8_1 - $4_1 | 0;
        HEAP32[($4_1 + 4 | 0) >> 2] = $7_1 | 1 | 0;
        HEAP32[$8_1 >> 2] = $7_1;
        label$76 : {
         label$77 : {
          if ($7_1 >>> 0 > 255 >>> 0) {
           break label$77
          }
          $0_1 = ($7_1 & -8 | 0) + 67744 | 0;
          label$78 : {
           label$79 : {
            $5_1 = HEAP32[(0 + 67704 | 0) >> 2] | 0;
            $7_1 = 1 << ($7_1 >>> 3 | 0) | 0;
            if ($5_1 & $7_1 | 0) {
             break label$79
            }
            HEAP32[(0 + 67704 | 0) >> 2] = $5_1 | $7_1 | 0;
            $5_1 = $0_1;
            break label$78;
           }
           $5_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
          }
          HEAP32[($0_1 + 8 | 0) >> 2] = $4_1;
          HEAP32[($5_1 + 12 | 0) >> 2] = $4_1;
          $7_1 = 12;
          $8_1 = 8;
          break label$76;
         }
         $0_1 = 31;
         label$80 : {
          if ($7_1 >>> 0 > 16777215 >>> 0) {
           break label$80
          }
          $0_1 = Math_clz32($7_1 >>> 8 | 0);
          $0_1 = ((($7_1 >>> (38 - $0_1 | 0) | 0) & 1 | 0) - ($0_1 << 1 | 0) | 0) + 62 | 0;
         }
         HEAP32[($4_1 + 28 | 0) >> 2] = $0_1;
         i64toi32_i32$1 = $4_1;
         i64toi32_i32$0 = 0;
         HEAP32[($4_1 + 16 | 0) >> 2] = 0;
         HEAP32[($4_1 + 20 | 0) >> 2] = i64toi32_i32$0;
         $5_1 = ($0_1 << 2 | 0) + 68008 | 0;
         label$81 : {
          label$82 : {
           label$83 : {
            $8_1 = HEAP32[(0 + 67708 | 0) >> 2] | 0;
            $2_1 = 1 << $0_1 | 0;
            if ($8_1 & $2_1 | 0) {
             break label$83
            }
            HEAP32[(0 + 67708 | 0) >> 2] = $8_1 | $2_1 | 0;
            HEAP32[$5_1 >> 2] = $4_1;
            HEAP32[($4_1 + 24 | 0) >> 2] = $5_1;
            break label$82;
           }
           $0_1 = $7_1 << (($0_1 | 0) == (31 | 0) ? 0 : 25 - ($0_1 >>> 1 | 0) | 0) | 0;
           $8_1 = HEAP32[$5_1 >> 2] | 0;
           label$84 : while (1) {
            $5_1 = $8_1;
            if (((HEAP32[($5_1 + 4 | 0) >> 2] | 0) & -8 | 0 | 0) == ($7_1 | 0)) {
             break label$81
            }
            $8_1 = $0_1 >>> 29 | 0;
            $0_1 = $0_1 << 1 | 0;
            $2_1 = ($5_1 + ($8_1 & 4 | 0) | 0) + 16 | 0;
            $8_1 = HEAP32[$2_1 >> 2] | 0;
            if ($8_1) {
             continue label$84
            }
            break label$84;
           };
           HEAP32[$2_1 >> 2] = $4_1;
           HEAP32[($4_1 + 24 | 0) >> 2] = $5_1;
          }
          $7_1 = 8;
          $8_1 = 12;
          $5_1 = $4_1;
          $0_1 = $4_1;
          break label$76;
         }
         $0_1 = HEAP32[($5_1 + 8 | 0) >> 2] | 0;
         HEAP32[($0_1 + 12 | 0) >> 2] = $4_1;
         HEAP32[($5_1 + 8 | 0) >> 2] = $4_1;
         HEAP32[($4_1 + 8 | 0) >> 2] = $0_1;
         $0_1 = 0;
         $7_1 = 24;
         $8_1 = 12;
        }
        HEAP32[($4_1 + $8_1 | 0) >> 2] = $5_1;
        HEAP32[($4_1 + $7_1 | 0) >> 2] = $0_1;
       }
       $0_1 = HEAP32[(0 + 67716 | 0) >> 2] | 0;
       if ($0_1 >>> 0 <= $3_1 >>> 0) {
        break label$5
       }
       $4_1 = $0_1 - $3_1 | 0;
       HEAP32[(0 + 67716 | 0) >> 2] = $4_1;
       $0_1 = HEAP32[(0 + 67728 | 0) >> 2] | 0;
       $5_1 = $0_1 + $3_1 | 0;
       HEAP32[(0 + 67728 | 0) >> 2] = $5_1;
       HEAP32[($5_1 + 4 | 0) >> 2] = $4_1 | 1 | 0;
       HEAP32[($0_1 + 4 | 0) >> 2] = $3_1 | 3 | 0;
       $0_1 = $0_1 + 8 | 0;
       break label$1;
      }
      HEAP32[($13() | 0) >> 2] = 48;
      $0_1 = 0;
      break label$1;
     }
     HEAP32[$0_1 >> 2] = $7_1;
     HEAP32[($0_1 + 4 | 0) >> 2] = (HEAP32[($0_1 + 4 | 0) >> 2] | 0) + $2_1 | 0;
     $0_1 = $16($7_1 | 0, $5_1 | 0, $3_1 | 0) | 0;
     break label$1;
    }
    label$85 : {
     if (!$11_1) {
      break label$85
     }
     label$86 : {
      label$87 : {
       $7_1 = HEAP32[($8_1 + 28 | 0) >> 2] | 0;
       $5_1 = ($7_1 << 2 | 0) + 68008 | 0;
       if (($8_1 | 0) != (HEAP32[$5_1 >> 2] | 0 | 0)) {
        break label$87
       }
       HEAP32[$5_1 >> 2] = $0_1;
       if ($0_1) {
        break label$86
       }
       $10_1 = $10_1 & (__wasm_rotl_i32(-2 | 0, $7_1 | 0) | 0) | 0;
       HEAP32[(0 + 67708 | 0) >> 2] = $10_1;
       break label$85;
      }
      HEAP32[($11_1 + ((HEAP32[($11_1 + 16 | 0) >> 2] | 0 | 0) == ($8_1 | 0) ? 16 : 20) | 0) >> 2] = $0_1;
      if (!$0_1) {
       break label$85
      }
     }
     HEAP32[($0_1 + 24 | 0) >> 2] = $11_1;
     label$88 : {
      $5_1 = HEAP32[($8_1 + 16 | 0) >> 2] | 0;
      if (!$5_1) {
       break label$88
      }
      HEAP32[($0_1 + 16 | 0) >> 2] = $5_1;
      HEAP32[($5_1 + 24 | 0) >> 2] = $0_1;
     }
     $5_1 = HEAP32[($8_1 + 20 | 0) >> 2] | 0;
     if (!$5_1) {
      break label$85
     }
     HEAP32[($0_1 + 20 | 0) >> 2] = $5_1;
     HEAP32[($5_1 + 24 | 0) >> 2] = $0_1;
    }
    label$89 : {
     label$90 : {
      if ($4_1 >>> 0 > 15 >>> 0) {
       break label$90
      }
      $0_1 = $4_1 + $3_1 | 0;
      HEAP32[($8_1 + 4 | 0) >> 2] = $0_1 | 3 | 0;
      $0_1 = $8_1 + $0_1 | 0;
      HEAP32[($0_1 + 4 | 0) >> 2] = HEAP32[($0_1 + 4 | 0) >> 2] | 0 | 1 | 0;
      break label$89;
     }
     HEAP32[($8_1 + 4 | 0) >> 2] = $3_1 | 3 | 0;
     $7_1 = $8_1 + $3_1 | 0;
     HEAP32[($7_1 + 4 | 0) >> 2] = $4_1 | 1 | 0;
     HEAP32[($7_1 + $4_1 | 0) >> 2] = $4_1;
     label$91 : {
      if ($4_1 >>> 0 > 255 >>> 0) {
       break label$91
      }
      $0_1 = ($4_1 & -8 | 0) + 67744 | 0;
      label$92 : {
       label$93 : {
        $3_1 = HEAP32[(0 + 67704 | 0) >> 2] | 0;
        $4_1 = 1 << ($4_1 >>> 3 | 0) | 0;
        if ($3_1 & $4_1 | 0) {
         break label$93
        }
        HEAP32[(0 + 67704 | 0) >> 2] = $3_1 | $4_1 | 0;
        $4_1 = $0_1;
        break label$92;
       }
       $4_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
      }
      HEAP32[($0_1 + 8 | 0) >> 2] = $7_1;
      HEAP32[($4_1 + 12 | 0) >> 2] = $7_1;
      HEAP32[($7_1 + 12 | 0) >> 2] = $0_1;
      HEAP32[($7_1 + 8 | 0) >> 2] = $4_1;
      break label$89;
     }
     $0_1 = 31;
     label$94 : {
      if ($4_1 >>> 0 > 16777215 >>> 0) {
       break label$94
      }
      $0_1 = Math_clz32($4_1 >>> 8 | 0);
      $0_1 = ((($4_1 >>> (38 - $0_1 | 0) | 0) & 1 | 0) - ($0_1 << 1 | 0) | 0) + 62 | 0;
     }
     HEAP32[($7_1 + 28 | 0) >> 2] = $0_1;
     i64toi32_i32$1 = $7_1;
     i64toi32_i32$0 = 0;
     HEAP32[($7_1 + 16 | 0) >> 2] = 0;
     HEAP32[($7_1 + 20 | 0) >> 2] = i64toi32_i32$0;
     $3_1 = ($0_1 << 2 | 0) + 68008 | 0;
     label$95 : {
      label$96 : {
       label$97 : {
        $5_1 = 1 << $0_1 | 0;
        if ($10_1 & $5_1 | 0) {
         break label$97
        }
        HEAP32[(0 + 67708 | 0) >> 2] = $10_1 | $5_1 | 0;
        HEAP32[$3_1 >> 2] = $7_1;
        HEAP32[($7_1 + 24 | 0) >> 2] = $3_1;
        break label$96;
       }
       $0_1 = $4_1 << (($0_1 | 0) == (31 | 0) ? 0 : 25 - ($0_1 >>> 1 | 0) | 0) | 0;
       $5_1 = HEAP32[$3_1 >> 2] | 0;
       label$98 : while (1) {
        $3_1 = $5_1;
        if (((HEAP32[($5_1 + 4 | 0) >> 2] | 0) & -8 | 0 | 0) == ($4_1 | 0)) {
         break label$95
        }
        $5_1 = $0_1 >>> 29 | 0;
        $0_1 = $0_1 << 1 | 0;
        $2_1 = ($3_1 + ($5_1 & 4 | 0) | 0) + 16 | 0;
        $5_1 = HEAP32[$2_1 >> 2] | 0;
        if ($5_1) {
         continue label$98
        }
        break label$98;
       };
       HEAP32[$2_1 >> 2] = $7_1;
       HEAP32[($7_1 + 24 | 0) >> 2] = $3_1;
      }
      HEAP32[($7_1 + 12 | 0) >> 2] = $7_1;
      HEAP32[($7_1 + 8 | 0) >> 2] = $7_1;
      break label$89;
     }
     $0_1 = HEAP32[($3_1 + 8 | 0) >> 2] | 0;
     HEAP32[($0_1 + 12 | 0) >> 2] = $7_1;
     HEAP32[($3_1 + 8 | 0) >> 2] = $7_1;
     HEAP32[($7_1 + 24 | 0) >> 2] = 0;
     HEAP32[($7_1 + 12 | 0) >> 2] = $3_1;
     HEAP32[($7_1 + 8 | 0) >> 2] = $0_1;
    }
    $0_1 = $8_1 + 8 | 0;
    break label$1;
   }
   label$99 : {
    if (!$10_1) {
     break label$99
    }
    label$100 : {
     label$101 : {
      $8_1 = HEAP32[($7_1 + 28 | 0) >> 2] | 0;
      $5_1 = ($8_1 << 2 | 0) + 68008 | 0;
      if (($7_1 | 0) != (HEAP32[$5_1 >> 2] | 0 | 0)) {
       break label$101
      }
      HEAP32[$5_1 >> 2] = $0_1;
      if ($0_1) {
       break label$100
      }
      HEAP32[(0 + 67708 | 0) >> 2] = $9_1 & (__wasm_rotl_i32(-2 | 0, $8_1 | 0) | 0) | 0;
      break label$99;
     }
     HEAP32[($10_1 + ((HEAP32[($10_1 + 16 | 0) >> 2] | 0 | 0) == ($7_1 | 0) ? 16 : 20) | 0) >> 2] = $0_1;
     if (!$0_1) {
      break label$99
     }
    }
    HEAP32[($0_1 + 24 | 0) >> 2] = $10_1;
    label$102 : {
     $5_1 = HEAP32[($7_1 + 16 | 0) >> 2] | 0;
     if (!$5_1) {
      break label$102
     }
     HEAP32[($0_1 + 16 | 0) >> 2] = $5_1;
     HEAP32[($5_1 + 24 | 0) >> 2] = $0_1;
    }
    $5_1 = HEAP32[($7_1 + 20 | 0) >> 2] | 0;
    if (!$5_1) {
     break label$99
    }
    HEAP32[($0_1 + 20 | 0) >> 2] = $5_1;
    HEAP32[($5_1 + 24 | 0) >> 2] = $0_1;
   }
   label$103 : {
    label$104 : {
     if ($4_1 >>> 0 > 15 >>> 0) {
      break label$104
     }
     $0_1 = $4_1 + $3_1 | 0;
     HEAP32[($7_1 + 4 | 0) >> 2] = $0_1 | 3 | 0;
     $0_1 = $7_1 + $0_1 | 0;
     HEAP32[($0_1 + 4 | 0) >> 2] = HEAP32[($0_1 + 4 | 0) >> 2] | 0 | 1 | 0;
     break label$103;
    }
    HEAP32[($7_1 + 4 | 0) >> 2] = $3_1 | 3 | 0;
    $3_1 = $7_1 + $3_1 | 0;
    HEAP32[($3_1 + 4 | 0) >> 2] = $4_1 | 1 | 0;
    HEAP32[($3_1 + $4_1 | 0) >> 2] = $4_1;
    label$105 : {
     if (!$6_1) {
      break label$105
     }
     $5_1 = ($6_1 & -8 | 0) + 67744 | 0;
     $0_1 = HEAP32[(0 + 67724 | 0) >> 2] | 0;
     label$106 : {
      label$107 : {
       $8_1 = 1 << ($6_1 >>> 3 | 0) | 0;
       if ($8_1 & $2_1 | 0) {
        break label$107
       }
       HEAP32[(0 + 67704 | 0) >> 2] = $8_1 | $2_1 | 0;
       $8_1 = $5_1;
       break label$106;
      }
      $8_1 = HEAP32[($5_1 + 8 | 0) >> 2] | 0;
     }
     HEAP32[($5_1 + 8 | 0) >> 2] = $0_1;
     HEAP32[($8_1 + 12 | 0) >> 2] = $0_1;
     HEAP32[($0_1 + 12 | 0) >> 2] = $5_1;
     HEAP32[($0_1 + 8 | 0) >> 2] = $8_1;
    }
    HEAP32[(0 + 67724 | 0) >> 2] = $3_1;
    HEAP32[(0 + 67712 | 0) >> 2] = $4_1;
   }
   $0_1 = $7_1 + 8 | 0;
  }
  global$0 = $1_1 + 16 | 0;
  return $0_1 | 0;
 }
 
 function $16($0_1, $1_1, $2_1) {
  $0_1 = $0_1 | 0;
  $1_1 = $1_1 | 0;
  $2_1 = $2_1 | 0;
  var $4_1 = 0, $5_1 = 0, $7_1 = 0, $8_1 = 0, $9_1 = 0, $3_1 = 0, $6_1 = 0;
  $3_1 = $0_1 + ((-8 - $0_1 | 0) & 7 | 0) | 0;
  HEAP32[($3_1 + 4 | 0) >> 2] = $2_1 | 3 | 0;
  $4_1 = $1_1 + ((-8 - $1_1 | 0) & 7 | 0) | 0;
  $5_1 = $3_1 + $2_1 | 0;
  $0_1 = $4_1 - $5_1 | 0;
  label$1 : {
   label$2 : {
    if (($4_1 | 0) != (HEAP32[(0 + 67728 | 0) >> 2] | 0 | 0)) {
     break label$2
    }
    HEAP32[(0 + 67728 | 0) >> 2] = $5_1;
    $2_1 = (HEAP32[(0 + 67716 | 0) >> 2] | 0) + $0_1 | 0;
    HEAP32[(0 + 67716 | 0) >> 2] = $2_1;
    HEAP32[($5_1 + 4 | 0) >> 2] = $2_1 | 1 | 0;
    break label$1;
   }
   label$3 : {
    if (($4_1 | 0) != (HEAP32[(0 + 67724 | 0) >> 2] | 0 | 0)) {
     break label$3
    }
    HEAP32[(0 + 67724 | 0) >> 2] = $5_1;
    $2_1 = (HEAP32[(0 + 67712 | 0) >> 2] | 0) + $0_1 | 0;
    HEAP32[(0 + 67712 | 0) >> 2] = $2_1;
    HEAP32[($5_1 + 4 | 0) >> 2] = $2_1 | 1 | 0;
    HEAP32[($5_1 + $2_1 | 0) >> 2] = $2_1;
    break label$1;
   }
   label$4 : {
    $1_1 = HEAP32[($4_1 + 4 | 0) >> 2] | 0;
    if (($1_1 & 3 | 0 | 0) != (1 | 0)) {
     break label$4
    }
    $6_1 = $1_1 & -8 | 0;
    $2_1 = HEAP32[($4_1 + 12 | 0) >> 2] | 0;
    label$5 : {
     label$6 : {
      if ($1_1 >>> 0 > 255 >>> 0) {
       break label$6
      }
      $7_1 = HEAP32[($4_1 + 8 | 0) >> 2] | 0;
      $8_1 = $1_1 >>> 3 | 0;
      $1_1 = ($8_1 << 3 | 0) + 67744 | 0;
      label$7 : {
       if (($2_1 | 0) != ($7_1 | 0)) {
        break label$7
       }
       HEAP32[(0 + 67704 | 0) >> 2] = (HEAP32[(0 + 67704 | 0) >> 2] | 0) & (__wasm_rotl_i32(-2 | 0, $8_1 | 0) | 0) | 0;
       break label$5;
      }
      HEAP32[($7_1 + 12 | 0) >> 2] = $2_1;
      HEAP32[($2_1 + 8 | 0) >> 2] = $7_1;
      break label$5;
     }
     $9_1 = HEAP32[($4_1 + 24 | 0) >> 2] | 0;
     label$8 : {
      label$9 : {
       if (($2_1 | 0) == ($4_1 | 0)) {
        break label$9
       }
       $1_1 = HEAP32[($4_1 + 8 | 0) >> 2] | 0;
       HEAP32[(0 + 67720 | 0) >> 2] | 0;
       HEAP32[($1_1 + 12 | 0) >> 2] = $2_1;
       HEAP32[($2_1 + 8 | 0) >> 2] = $1_1;
       break label$8;
      }
      label$10 : {
       label$11 : {
        label$12 : {
         $1_1 = HEAP32[($4_1 + 20 | 0) >> 2] | 0;
         if (!$1_1) {
          break label$12
         }
         $7_1 = $4_1 + 20 | 0;
         break label$11;
        }
        $1_1 = HEAP32[($4_1 + 16 | 0) >> 2] | 0;
        if (!$1_1) {
         break label$10
        }
        $7_1 = $4_1 + 16 | 0;
       }
       label$13 : while (1) {
        $8_1 = $7_1;
        $2_1 = $1_1;
        $7_1 = $2_1 + 20 | 0;
        $1_1 = HEAP32[($2_1 + 20 | 0) >> 2] | 0;
        if ($1_1) {
         continue label$13
        }
        $7_1 = $2_1 + 16 | 0;
        $1_1 = HEAP32[($2_1 + 16 | 0) >> 2] | 0;
        if ($1_1) {
         continue label$13
        }
        break label$13;
       };
       HEAP32[$8_1 >> 2] = 0;
       break label$8;
      }
      $2_1 = 0;
     }
     if (!$9_1) {
      break label$5
     }
     label$14 : {
      label$15 : {
       $7_1 = HEAP32[($4_1 + 28 | 0) >> 2] | 0;
       $1_1 = ($7_1 << 2 | 0) + 68008 | 0;
       if (($4_1 | 0) != (HEAP32[$1_1 >> 2] | 0 | 0)) {
        break label$15
       }
       HEAP32[$1_1 >> 2] = $2_1;
       if ($2_1) {
        break label$14
       }
       HEAP32[(0 + 67708 | 0) >> 2] = (HEAP32[(0 + 67708 | 0) >> 2] | 0) & (__wasm_rotl_i32(-2 | 0, $7_1 | 0) | 0) | 0;
       break label$5;
      }
      HEAP32[($9_1 + ((HEAP32[($9_1 + 16 | 0) >> 2] | 0 | 0) == ($4_1 | 0) ? 16 : 20) | 0) >> 2] = $2_1;
      if (!$2_1) {
       break label$5
      }
     }
     HEAP32[($2_1 + 24 | 0) >> 2] = $9_1;
     label$16 : {
      $1_1 = HEAP32[($4_1 + 16 | 0) >> 2] | 0;
      if (!$1_1) {
       break label$16
      }
      HEAP32[($2_1 + 16 | 0) >> 2] = $1_1;
      HEAP32[($1_1 + 24 | 0) >> 2] = $2_1;
     }
     $1_1 = HEAP32[($4_1 + 20 | 0) >> 2] | 0;
     if (!$1_1) {
      break label$5
     }
     HEAP32[($2_1 + 20 | 0) >> 2] = $1_1;
     HEAP32[($1_1 + 24 | 0) >> 2] = $2_1;
    }
    $0_1 = $6_1 + $0_1 | 0;
    $4_1 = $4_1 + $6_1 | 0;
    $1_1 = HEAP32[($4_1 + 4 | 0) >> 2] | 0;
   }
   HEAP32[($4_1 + 4 | 0) >> 2] = $1_1 & -2 | 0;
   HEAP32[($5_1 + 4 | 0) >> 2] = $0_1 | 1 | 0;
   HEAP32[($5_1 + $0_1 | 0) >> 2] = $0_1;
   label$17 : {
    if ($0_1 >>> 0 > 255 >>> 0) {
     break label$17
    }
    $2_1 = ($0_1 & -8 | 0) + 67744 | 0;
    label$18 : {
     label$19 : {
      $1_1 = HEAP32[(0 + 67704 | 0) >> 2] | 0;
      $0_1 = 1 << ($0_1 >>> 3 | 0) | 0;
      if ($1_1 & $0_1 | 0) {
       break label$19
      }
      HEAP32[(0 + 67704 | 0) >> 2] = $1_1 | $0_1 | 0;
      $0_1 = $2_1;
      break label$18;
     }
     $0_1 = HEAP32[($2_1 + 8 | 0) >> 2] | 0;
    }
    HEAP32[($2_1 + 8 | 0) >> 2] = $5_1;
    HEAP32[($0_1 + 12 | 0) >> 2] = $5_1;
    HEAP32[($5_1 + 12 | 0) >> 2] = $2_1;
    HEAP32[($5_1 + 8 | 0) >> 2] = $0_1;
    break label$1;
   }
   $2_1 = 31;
   label$20 : {
    if ($0_1 >>> 0 > 16777215 >>> 0) {
     break label$20
    }
    $2_1 = Math_clz32($0_1 >>> 8 | 0);
    $2_1 = ((($0_1 >>> (38 - $2_1 | 0) | 0) & 1 | 0) - ($2_1 << 1 | 0) | 0) + 62 | 0;
   }
   HEAP32[($5_1 + 28 | 0) >> 2] = $2_1;
   HEAP32[($5_1 + 16 | 0) >> 2] = 0;
   HEAP32[($5_1 + 20 | 0) >> 2] = 0;
   $1_1 = ($2_1 << 2 | 0) + 68008 | 0;
   label$21 : {
    label$22 : {
     label$23 : {
      $7_1 = HEAP32[(0 + 67708 | 0) >> 2] | 0;
      $4_1 = 1 << $2_1 | 0;
      if ($7_1 & $4_1 | 0) {
       break label$23
      }
      HEAP32[(0 + 67708 | 0) >> 2] = $7_1 | $4_1 | 0;
      HEAP32[$1_1 >> 2] = $5_1;
      HEAP32[($5_1 + 24 | 0) >> 2] = $1_1;
      break label$22;
     }
     $2_1 = $0_1 << (($2_1 | 0) == (31 | 0) ? 0 : 25 - ($2_1 >>> 1 | 0) | 0) | 0;
     $7_1 = HEAP32[$1_1 >> 2] | 0;
     label$24 : while (1) {
      $1_1 = $7_1;
      if (((HEAP32[($1_1 + 4 | 0) >> 2] | 0) & -8 | 0 | 0) == ($0_1 | 0)) {
       break label$21
      }
      $7_1 = $2_1 >>> 29 | 0;
      $2_1 = $2_1 << 1 | 0;
      $4_1 = ($1_1 + ($7_1 & 4 | 0) | 0) + 16 | 0;
      $7_1 = HEAP32[$4_1 >> 2] | 0;
      if ($7_1) {
       continue label$24
      }
      break label$24;
     };
     HEAP32[$4_1 >> 2] = $5_1;
     HEAP32[($5_1 + 24 | 0) >> 2] = $1_1;
    }
    HEAP32[($5_1 + 12 | 0) >> 2] = $5_1;
    HEAP32[($5_1 + 8 | 0) >> 2] = $5_1;
    break label$1;
   }
   $2_1 = HEAP32[($1_1 + 8 | 0) >> 2] | 0;
   HEAP32[($2_1 + 12 | 0) >> 2] = $5_1;
   HEAP32[($1_1 + 8 | 0) >> 2] = $5_1;
   HEAP32[($5_1 + 24 | 0) >> 2] = 0;
   HEAP32[($5_1 + 12 | 0) >> 2] = $1_1;
   HEAP32[($5_1 + 8 | 0) >> 2] = $2_1;
  }
  return $3_1 + 8 | 0 | 0;
 }
 
 function $17($0_1) {
  $0_1 = $0_1 | 0;
  var $4_1 = 0, $2_1 = 0, $1_1 = 0, $5_1 = 0, $3_1 = 0, $6_1 = 0, $7_1 = 0;
  label$1 : {
   if (!$0_1) {
    break label$1
   }
   $1_1 = $0_1 + -8 | 0;
   $2_1 = HEAP32[($0_1 + -4 | 0) >> 2] | 0;
   $0_1 = $2_1 & -8 | 0;
   $3_1 = $1_1 + $0_1 | 0;
   label$2 : {
    if ($2_1 & 1 | 0) {
     break label$2
    }
    if (!($2_1 & 2 | 0)) {
     break label$1
    }
    $4_1 = HEAP32[$1_1 >> 2] | 0;
    $1_1 = $1_1 - $4_1 | 0;
    $5_1 = HEAP32[(0 + 67720 | 0) >> 2] | 0;
    if ($1_1 >>> 0 < $5_1 >>> 0) {
     break label$1
    }
    $0_1 = $4_1 + $0_1 | 0;
    label$3 : {
     label$4 : {
      label$5 : {
       if (($1_1 | 0) == (HEAP32[(0 + 67724 | 0) >> 2] | 0 | 0)) {
        break label$5
       }
       $2_1 = HEAP32[($1_1 + 12 | 0) >> 2] | 0;
       label$6 : {
        if ($4_1 >>> 0 > 255 >>> 0) {
         break label$6
        }
        $5_1 = HEAP32[($1_1 + 8 | 0) >> 2] | 0;
        $6_1 = $4_1 >>> 3 | 0;
        $4_1 = ($6_1 << 3 | 0) + 67744 | 0;
        label$7 : {
         if (($2_1 | 0) != ($5_1 | 0)) {
          break label$7
         }
         HEAP32[(0 + 67704 | 0) >> 2] = (HEAP32[(0 + 67704 | 0) >> 2] | 0) & (__wasm_rotl_i32(-2 | 0, $6_1 | 0) | 0) | 0;
         break label$2;
        }
        HEAP32[($5_1 + 12 | 0) >> 2] = $2_1;
        HEAP32[($2_1 + 8 | 0) >> 2] = $5_1;
        break label$2;
       }
       $7_1 = HEAP32[($1_1 + 24 | 0) >> 2] | 0;
       label$8 : {
        if (($2_1 | 0) == ($1_1 | 0)) {
         break label$8
        }
        $4_1 = HEAP32[($1_1 + 8 | 0) >> 2] | 0;
        HEAP32[($4_1 + 12 | 0) >> 2] = $2_1;
        HEAP32[($2_1 + 8 | 0) >> 2] = $4_1;
        break label$3;
       }
       label$9 : {
        label$10 : {
         $4_1 = HEAP32[($1_1 + 20 | 0) >> 2] | 0;
         if (!$4_1) {
          break label$10
         }
         $5_1 = $1_1 + 20 | 0;
         break label$9;
        }
        $4_1 = HEAP32[($1_1 + 16 | 0) >> 2] | 0;
        if (!$4_1) {
         break label$4
        }
        $5_1 = $1_1 + 16 | 0;
       }
       label$11 : while (1) {
        $6_1 = $5_1;
        $2_1 = $4_1;
        $5_1 = $2_1 + 20 | 0;
        $4_1 = HEAP32[($2_1 + 20 | 0) >> 2] | 0;
        if ($4_1) {
         continue label$11
        }
        $5_1 = $2_1 + 16 | 0;
        $4_1 = HEAP32[($2_1 + 16 | 0) >> 2] | 0;
        if ($4_1) {
         continue label$11
        }
        break label$11;
       };
       HEAP32[$6_1 >> 2] = 0;
       break label$3;
      }
      $2_1 = HEAP32[($3_1 + 4 | 0) >> 2] | 0;
      if (($2_1 & 3 | 0 | 0) != (3 | 0)) {
       break label$2
      }
      HEAP32[(0 + 67712 | 0) >> 2] = $0_1;
      HEAP32[($3_1 + 4 | 0) >> 2] = $2_1 & -2 | 0;
      HEAP32[($1_1 + 4 | 0) >> 2] = $0_1 | 1 | 0;
      HEAP32[$3_1 >> 2] = $0_1;
      return;
     }
     $2_1 = 0;
    }
    if (!$7_1) {
     break label$2
    }
    label$12 : {
     label$13 : {
      $5_1 = HEAP32[($1_1 + 28 | 0) >> 2] | 0;
      $4_1 = ($5_1 << 2 | 0) + 68008 | 0;
      if (($1_1 | 0) != (HEAP32[$4_1 >> 2] | 0 | 0)) {
       break label$13
      }
      HEAP32[$4_1 >> 2] = $2_1;
      if ($2_1) {
       break label$12
      }
      HEAP32[(0 + 67708 | 0) >> 2] = (HEAP32[(0 + 67708 | 0) >> 2] | 0) & (__wasm_rotl_i32(-2 | 0, $5_1 | 0) | 0) | 0;
      break label$2;
     }
     HEAP32[($7_1 + ((HEAP32[($7_1 + 16 | 0) >> 2] | 0 | 0) == ($1_1 | 0) ? 16 : 20) | 0) >> 2] = $2_1;
     if (!$2_1) {
      break label$2
     }
    }
    HEAP32[($2_1 + 24 | 0) >> 2] = $7_1;
    label$14 : {
     $4_1 = HEAP32[($1_1 + 16 | 0) >> 2] | 0;
     if (!$4_1) {
      break label$14
     }
     HEAP32[($2_1 + 16 | 0) >> 2] = $4_1;
     HEAP32[($4_1 + 24 | 0) >> 2] = $2_1;
    }
    $4_1 = HEAP32[($1_1 + 20 | 0) >> 2] | 0;
    if (!$4_1) {
     break label$2
    }
    HEAP32[($2_1 + 20 | 0) >> 2] = $4_1;
    HEAP32[($4_1 + 24 | 0) >> 2] = $2_1;
   }
   if ($1_1 >>> 0 >= $3_1 >>> 0) {
    break label$1
   }
   $4_1 = HEAP32[($3_1 + 4 | 0) >> 2] | 0;
   if (!($4_1 & 1 | 0)) {
    break label$1
   }
   label$15 : {
    label$16 : {
     label$17 : {
      label$18 : {
       label$19 : {
        if ($4_1 & 2 | 0) {
         break label$19
        }
        label$20 : {
         if (($3_1 | 0) != (HEAP32[(0 + 67728 | 0) >> 2] | 0 | 0)) {
          break label$20
         }
         HEAP32[(0 + 67728 | 0) >> 2] = $1_1;
         $0_1 = (HEAP32[(0 + 67716 | 0) >> 2] | 0) + $0_1 | 0;
         HEAP32[(0 + 67716 | 0) >> 2] = $0_1;
         HEAP32[($1_1 + 4 | 0) >> 2] = $0_1 | 1 | 0;
         if (($1_1 | 0) != (HEAP32[(0 + 67724 | 0) >> 2] | 0 | 0)) {
          break label$1
         }
         HEAP32[(0 + 67712 | 0) >> 2] = 0;
         HEAP32[(0 + 67724 | 0) >> 2] = 0;
         return;
        }
        label$21 : {
         if (($3_1 | 0) != (HEAP32[(0 + 67724 | 0) >> 2] | 0 | 0)) {
          break label$21
         }
         HEAP32[(0 + 67724 | 0) >> 2] = $1_1;
         $0_1 = (HEAP32[(0 + 67712 | 0) >> 2] | 0) + $0_1 | 0;
         HEAP32[(0 + 67712 | 0) >> 2] = $0_1;
         HEAP32[($1_1 + 4 | 0) >> 2] = $0_1 | 1 | 0;
         HEAP32[($1_1 + $0_1 | 0) >> 2] = $0_1;
         return;
        }
        $0_1 = ($4_1 & -8 | 0) + $0_1 | 0;
        $2_1 = HEAP32[($3_1 + 12 | 0) >> 2] | 0;
        label$22 : {
         if ($4_1 >>> 0 > 255 >>> 0) {
          break label$22
         }
         $5_1 = HEAP32[($3_1 + 8 | 0) >> 2] | 0;
         $3_1 = $4_1 >>> 3 | 0;
         $4_1 = ($3_1 << 3 | 0) + 67744 | 0;
         label$23 : {
          if (($2_1 | 0) != ($5_1 | 0)) {
           break label$23
          }
          HEAP32[(0 + 67704 | 0) >> 2] = (HEAP32[(0 + 67704 | 0) >> 2] | 0) & (__wasm_rotl_i32(-2 | 0, $3_1 | 0) | 0) | 0;
          break label$16;
         }
         HEAP32[($5_1 + 12 | 0) >> 2] = $2_1;
         HEAP32[($2_1 + 8 | 0) >> 2] = $5_1;
         break label$16;
        }
        $7_1 = HEAP32[($3_1 + 24 | 0) >> 2] | 0;
        label$24 : {
         if (($2_1 | 0) == ($3_1 | 0)) {
          break label$24
         }
         $4_1 = HEAP32[($3_1 + 8 | 0) >> 2] | 0;
         HEAP32[(0 + 67720 | 0) >> 2] | 0;
         HEAP32[($4_1 + 12 | 0) >> 2] = $2_1;
         HEAP32[($2_1 + 8 | 0) >> 2] = $4_1;
         break label$17;
        }
        label$25 : {
         label$26 : {
          $4_1 = HEAP32[($3_1 + 20 | 0) >> 2] | 0;
          if (!$4_1) {
           break label$26
          }
          $5_1 = $3_1 + 20 | 0;
          break label$25;
         }
         $4_1 = HEAP32[($3_1 + 16 | 0) >> 2] | 0;
         if (!$4_1) {
          break label$18
         }
         $5_1 = $3_1 + 16 | 0;
        }
        label$27 : while (1) {
         $6_1 = $5_1;
         $2_1 = $4_1;
         $5_1 = $2_1 + 20 | 0;
         $4_1 = HEAP32[($2_1 + 20 | 0) >> 2] | 0;
         if ($4_1) {
          continue label$27
         }
         $5_1 = $2_1 + 16 | 0;
         $4_1 = HEAP32[($2_1 + 16 | 0) >> 2] | 0;
         if ($4_1) {
          continue label$27
         }
         break label$27;
        };
        HEAP32[$6_1 >> 2] = 0;
        break label$17;
       }
       HEAP32[($3_1 + 4 | 0) >> 2] = $4_1 & -2 | 0;
       HEAP32[($1_1 + 4 | 0) >> 2] = $0_1 | 1 | 0;
       HEAP32[($1_1 + $0_1 | 0) >> 2] = $0_1;
       break label$15;
      }
      $2_1 = 0;
     }
     if (!$7_1) {
      break label$16
     }
     label$28 : {
      label$29 : {
       $5_1 = HEAP32[($3_1 + 28 | 0) >> 2] | 0;
       $4_1 = ($5_1 << 2 | 0) + 68008 | 0;
       if (($3_1 | 0) != (HEAP32[$4_1 >> 2] | 0 | 0)) {
        break label$29
       }
       HEAP32[$4_1 >> 2] = $2_1;
       if ($2_1) {
        break label$28
       }
       HEAP32[(0 + 67708 | 0) >> 2] = (HEAP32[(0 + 67708 | 0) >> 2] | 0) & (__wasm_rotl_i32(-2 | 0, $5_1 | 0) | 0) | 0;
       break label$16;
      }
      HEAP32[($7_1 + ((HEAP32[($7_1 + 16 | 0) >> 2] | 0 | 0) == ($3_1 | 0) ? 16 : 20) | 0) >> 2] = $2_1;
      if (!$2_1) {
       break label$16
      }
     }
     HEAP32[($2_1 + 24 | 0) >> 2] = $7_1;
     label$30 : {
      $4_1 = HEAP32[($3_1 + 16 | 0) >> 2] | 0;
      if (!$4_1) {
       break label$30
      }
      HEAP32[($2_1 + 16 | 0) >> 2] = $4_1;
      HEAP32[($4_1 + 24 | 0) >> 2] = $2_1;
     }
     $4_1 = HEAP32[($3_1 + 20 | 0) >> 2] | 0;
     if (!$4_1) {
      break label$16
     }
     HEAP32[($2_1 + 20 | 0) >> 2] = $4_1;
     HEAP32[($4_1 + 24 | 0) >> 2] = $2_1;
    }
    HEAP32[($1_1 + 4 | 0) >> 2] = $0_1 | 1 | 0;
    HEAP32[($1_1 + $0_1 | 0) >> 2] = $0_1;
    if (($1_1 | 0) != (HEAP32[(0 + 67724 | 0) >> 2] | 0 | 0)) {
     break label$15
    }
    HEAP32[(0 + 67712 | 0) >> 2] = $0_1;
    return;
   }
   label$31 : {
    if ($0_1 >>> 0 > 255 >>> 0) {
     break label$31
    }
    $2_1 = ($0_1 & -8 | 0) + 67744 | 0;
    label$32 : {
     label$33 : {
      $4_1 = HEAP32[(0 + 67704 | 0) >> 2] | 0;
      $0_1 = 1 << ($0_1 >>> 3 | 0) | 0;
      if ($4_1 & $0_1 | 0) {
       break label$33
      }
      HEAP32[(0 + 67704 | 0) >> 2] = $4_1 | $0_1 | 0;
      $0_1 = $2_1;
      break label$32;
     }
     $0_1 = HEAP32[($2_1 + 8 | 0) >> 2] | 0;
    }
    HEAP32[($2_1 + 8 | 0) >> 2] = $1_1;
    HEAP32[($0_1 + 12 | 0) >> 2] = $1_1;
    HEAP32[($1_1 + 12 | 0) >> 2] = $2_1;
    HEAP32[($1_1 + 8 | 0) >> 2] = $0_1;
    return;
   }
   $2_1 = 31;
   label$34 : {
    if ($0_1 >>> 0 > 16777215 >>> 0) {
     break label$34
    }
    $2_1 = Math_clz32($0_1 >>> 8 | 0);
    $2_1 = ((($0_1 >>> (38 - $2_1 | 0) | 0) & 1 | 0) - ($2_1 << 1 | 0) | 0) + 62 | 0;
   }
   HEAP32[($1_1 + 28 | 0) >> 2] = $2_1;
   HEAP32[($1_1 + 16 | 0) >> 2] = 0;
   HEAP32[($1_1 + 20 | 0) >> 2] = 0;
   $3_1 = ($2_1 << 2 | 0) + 68008 | 0;
   label$35 : {
    label$36 : {
     label$37 : {
      label$38 : {
       $4_1 = HEAP32[(0 + 67708 | 0) >> 2] | 0;
       $5_1 = 1 << $2_1 | 0;
       if ($4_1 & $5_1 | 0) {
        break label$38
       }
       HEAP32[(0 + 67708 | 0) >> 2] = $4_1 | $5_1 | 0;
       $0_1 = 8;
       $2_1 = 24;
       $5_1 = $3_1;
       break label$37;
      }
      $2_1 = $0_1 << (($2_1 | 0) == (31 | 0) ? 0 : 25 - ($2_1 >>> 1 | 0) | 0) | 0;
      $5_1 = HEAP32[$3_1 >> 2] | 0;
      label$39 : while (1) {
       $4_1 = $5_1;
       if (((HEAP32[($4_1 + 4 | 0) >> 2] | 0) & -8 | 0 | 0) == ($0_1 | 0)) {
        break label$36
       }
       $5_1 = $2_1 >>> 29 | 0;
       $2_1 = $2_1 << 1 | 0;
       $3_1 = ($4_1 + ($5_1 & 4 | 0) | 0) + 16 | 0;
       $5_1 = HEAP32[$3_1 >> 2] | 0;
       if ($5_1) {
        continue label$39
       }
       break label$39;
      };
      $0_1 = 8;
      $2_1 = 24;
      $5_1 = $4_1;
     }
     $4_1 = $1_1;
     $6_1 = $4_1;
     break label$35;
    }
    $5_1 = HEAP32[($4_1 + 8 | 0) >> 2] | 0;
    HEAP32[($5_1 + 12 | 0) >> 2] = $1_1;
    $2_1 = 8;
    $3_1 = $4_1 + 8 | 0;
    $6_1 = 0;
    $0_1 = 24;
   }
   HEAP32[$3_1 >> 2] = $1_1;
   HEAP32[($1_1 + $2_1 | 0) >> 2] = $5_1;
   HEAP32[($1_1 + 12 | 0) >> 2] = $4_1;
   HEAP32[($1_1 + $0_1 | 0) >> 2] = $6_1;
   $1_1 = (HEAP32[(0 + 67736 | 0) >> 2] | 0) + -1 | 0;
   HEAP32[(0 + 67736 | 0) >> 2] = $1_1 ? $1_1 : -1;
  }
 }
 
 function $20($0_1) {
  $0_1 = $0_1 | 0;
 }
 
 function $21($0_1) {
  $0_1 = $0_1 | 0;
 }
 
 function $22() {
  $20(68200 | 0);
  return 68204 | 0;
 }
 
 function $23() {
  $21(68200 | 0);
 }
 
 function $24($0_1) {
  $0_1 = $0_1 | 0;
  return 1 | 0;
 }
 
 function $25($0_1) {
  $0_1 = $0_1 | 0;
 }
 
 function $26($0_1) {
  $0_1 = $0_1 | 0;
  var $1_1 = 0, i64toi32_i32$1 = 0, $2_1 = 0, i64toi32_i32$0 = 0, $3_1 = 0;
  label$1 : {
   if ($0_1) {
    break label$1
   }
   $1_1 = 0;
   label$2 : {
    if (!(HEAP32[(0 + 68208 | 0) >> 2] | 0)) {
     break label$2
    }
    $1_1 = $26(HEAP32[(0 + 68208 | 0) >> 2] | 0 | 0) | 0;
   }
   label$3 : {
    if (!(HEAP32[(0 + 68208 | 0) >> 2] | 0)) {
     break label$3
    }
    $1_1 = $26(HEAP32[(0 + 68208 | 0) >> 2] | 0 | 0) | 0 | $1_1 | 0;
   }
   label$4 : {
    $0_1 = HEAP32[($22() | 0) >> 2] | 0;
    if (!$0_1) {
     break label$4
    }
    label$5 : while (1) {
     $2_1 = 0;
     label$6 : {
      if ((HEAP32[($0_1 + 76 | 0) >> 2] | 0 | 0) < (0 | 0)) {
       break label$6
      }
      $2_1 = $24($0_1 | 0) | 0;
     }
     label$7 : {
      if ((HEAP32[($0_1 + 20 | 0) >> 2] | 0 | 0) == (HEAP32[($0_1 + 28 | 0) >> 2] | 0 | 0)) {
       break label$7
      }
      $1_1 = $26($0_1 | 0) | 0 | $1_1 | 0;
     }
     label$8 : {
      if (!$2_1) {
       break label$8
      }
      $25($0_1 | 0);
     }
     $0_1 = HEAP32[($0_1 + 56 | 0) >> 2] | 0;
     if ($0_1) {
      continue label$5
     }
     break label$5;
    };
   }
   $23();
   return $1_1 | 0;
  }
  label$9 : {
   label$10 : {
    if ((HEAP32[($0_1 + 76 | 0) >> 2] | 0 | 0) >= (0 | 0)) {
     break label$10
    }
    $2_1 = 1;
    break label$9;
   }
   $2_1 = !($24($0_1 | 0) | 0);
  }
  label$11 : {
   label$12 : {
    label$13 : {
     if ((HEAP32[($0_1 + 20 | 0) >> 2] | 0 | 0) == (HEAP32[($0_1 + 28 | 0) >> 2] | 0 | 0)) {
      break label$13
     }
     FUNCTION_TABLE[HEAP32[($0_1 + 36 | 0) >> 2] | 0 | 0]($0_1, 0, 0) | 0;
     if (HEAP32[($0_1 + 20 | 0) >> 2] | 0) {
      break label$13
     }
     $1_1 = -1;
     if (!$2_1) {
      break label$12
     }
     break label$11;
    }
    label$14 : {
     $1_1 = HEAP32[($0_1 + 4 | 0) >> 2] | 0;
     $3_1 = HEAP32[($0_1 + 8 | 0) >> 2] | 0;
     if (($1_1 | 0) == ($3_1 | 0)) {
      break label$14
     }
     i64toi32_i32$1 = $1_1 - $3_1 | 0;
     i64toi32_i32$0 = i64toi32_i32$1 >> 31 | 0;
     i64toi32_i32$0 = FUNCTION_TABLE[HEAP32[($0_1 + 40 | 0) >> 2] | 0 | 0]($0_1, i64toi32_i32$1, i64toi32_i32$0, 1) | 0;
     i64toi32_i32$1 = i64toi32_i32$HIGH_BITS;
    }
    $1_1 = 0;
    HEAP32[($0_1 + 28 | 0) >> 2] = 0;
    i64toi32_i32$0 = $0_1;
    i64toi32_i32$1 = 0;
    HEAP32[($0_1 + 16 | 0) >> 2] = 0;
    HEAP32[($0_1 + 20 | 0) >> 2] = i64toi32_i32$1;
    i64toi32_i32$0 = $0_1;
    i64toi32_i32$1 = 0;
    HEAP32[($0_1 + 4 | 0) >> 2] = 0;
    HEAP32[($0_1 + 8 | 0) >> 2] = i64toi32_i32$1;
    if ($2_1) {
     break label$11
    }
   }
   $25($0_1 | 0);
  }
  return $1_1 | 0;
 }
 
 function $27() {
  global$3 = 65536;
  global$2 = (0 + 15 | 0) & -16 | 0;
 }
 
 function $28() {
  return global$0 - global$2 | 0 | 0;
 }
 
 function $29() {
  return global$3 | 0;
 }
 
 function $30() {
  return global$2 | 0;
 }
 
 function $31() {
  return global$0 | 0;
 }
 
 function $32($0_1) {
  $0_1 = $0_1 | 0;
  global$0 = $0_1;
 }
 
 function $33($0_1) {
  $0_1 = $0_1 | 0;
  var $1_1 = 0;
  $1_1 = (global$0 - $0_1 | 0) & -16 | 0;
  global$0 = $1_1;
  return $1_1 | 0;
 }
 
 function $34() {
  return global$0 | 0;
 }
 
 function __wasm_ctz_i32(var$0) {
  var$0 = var$0 | 0;
  if (var$0) {
   return 31 - Math_clz32((var$0 + -1 | 0) ^ var$0 | 0) | 0 | 0
  }
  return 32 | 0;
 }
 
 function __wasm_rotl_i32(var$0, var$1) {
  var$0 = var$0 | 0;
  var$1 = var$1 | 0;
  var var$2 = 0;
  var$2 = var$1 & 31 | 0;
  var$1 = (0 - var$1 | 0) & 31 | 0;
  return ((-1 >>> var$2 | 0) & var$0 | 0) << var$2 | 0 | (((-1 << var$1 | 0) & var$0 | 0) >>> var$1 | 0) | 0 | 0;
 }
 
 // EMSCRIPTEN_END_FUNCS
;
 bufferView = HEAPU8;
 initActiveSegments(imports);
 var FUNCTION_TABLE = Table([]);
 function __wasm_memory_size() {
  return buffer.byteLength / 65536 | 0;
 }
 
 return {
  "memory": Object.create(Object.prototype, {
   "grow": {
    
   }, 
   "buffer": {
    "get": function () {
     return buffer;
    }
    
   }
  }), 
  "__wasm_call_ctors": $0, 
  "wavelet_sharpen": $2, 
  "malloc": $15, 
  "free": $17, 
  "fflush": $26, 
  "__indirect_function_table": FUNCTION_TABLE, 
  "emscripten_stack_init": $27, 
  "emscripten_stack_get_free": $28, 
  "emscripten_stack_get_base": $29, 
  "emscripten_stack_get_end": $30, 
  "stackSave": $31, 
  "stackRestore": $32, 
  "stackAlloc": $33, 
  "emscripten_stack_get_current": $34
 };
}

  return asmFunc(info);
}

)(info);
  },

  instantiate: /** @suppress{checkTypes} */ function(binary, info) {
    return {
      then: function(ok) {
        var module = new WebAssembly.Module(binary);
        ok({
          'instance': new WebAssembly.Instance(module, info)
        });
        // Emulate a simple WebAssembly.instantiate(..).then(()=>{}).catch(()=>{}) syntax.
        return { catch: function() {} };
      }
    };
  },

  RuntimeError: Error
};

// We don't need to actually download a wasm binary, mark it as present but empty.
wasmBinary = [];
