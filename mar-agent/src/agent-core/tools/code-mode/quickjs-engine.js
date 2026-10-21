import { BoundedTextOutput } from './text-output.js';

// This trusted module runs only in the Host-managed worker, never in the model's JS context.
/** @returns {Promise<import('./engine.js').CodeModeEngine>} */
export async function createCodeModeEngine(options) {
  const { newQuickJSWASMModuleFromVariant } = await import(options.coreModuleUrl);
  const variant = (await import(options.variantModuleUrl)).default;
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  let runtime;
  let context;
  let disposed = false;
  return {
    async execute(input) {
      if (disposed || runtime) throw diagnostic('MAR_AGENT_CODE_FAILED', 'Engine is not reusable.');
      runtime = quickjs.newRuntime();
      // QuickJS 0.32.0 caches the job's context-pointer view across WASM memory growth
      // (upstream #240). A detached view creates an unowned Context and breaks disposal.
      // Keep this dependency-specific correction inside the worker engine; preserve its
      // pointer allocation/free lifecycle and always read from the current heap.
      const newMutablePointerArray = runtime.memory.newMutablePointerArray.bind(runtime.memory);
      runtime.memory.newMutablePointerArray = (length) => {
        const pointer = newMutablePointerArray(length);
        Object.defineProperty(pointer.value, 'typedArray', {
          get: () => new Int32Array(runtime.module.HEAP8.buffer, pointer.value.ptr, length)
        });
        return pointer;
      };
      runtime.setMemoryLimit(input.limits.memoryBytes);
      runtime.setMaxStackSize(input.limits.stackBytes);
      let executionMs = 0;
      let executionStarted;
      const budgetExceeded = () =>
        executionMs + (executionStarted === undefined ? 0 : performance.now() - executionStarted) >=
        input.limits.timeoutMs;
      const executionTimeout = () =>
        diagnostic('MAR_AGENT_CODE_TIMEOUT', 'JavaScript execution exceeded its execution budget.');
      // Charge only synchronous guest work, including reentrant bridge calls, not async waiting.
      const runGuest = (run) => {
        input.signal.throwIfAborted();
        if (budgetExceeded()) throw executionTimeout();
        const outermost = executionStarted === undefined;
        if (outermost) executionStarted = performance.now();
        try {
          return run();
        } finally {
          if (outermost) {
            executionMs += performance.now() - executionStarted;
            executionStarted = undefined;
          }
        }
      };
      runtime.setInterruptHandler(() => input.signal.aborted || budgetExceeded());
      context = runtime.newContext();
      const vm = context;
      let wake;
      let bridgeFailure;
      const pending = new Set();
      const deferreds = new Set();
      const unconsumedToolCalls = new Set();
      const sleepTimers = new Set();
      const state = new Map(input.state.map((entry) => [entry.key, entry.value]));
      const stateMutations = [];
      let outputBytes = 0;
      let textCalls = 0;
      const origins = [];
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      const fail = (handle, locateSource = false) => {
        let error;
        try {
          error = runGuest(() => vm.dump(handle));
        } finally {
          handle.dispose();
        }
        if (budgetExceeded()) throw executionTimeout();
        let message = String(error?.message ?? error).slice(0, 4096);
        const syntaxError = locateSource && error?.name === 'SyntaxError';
        if (syntaxError)
          message = `JavaScript compilation failed before tool execution: ${message}`.slice(
            0,
            4096
          );
        if (
          error?.name === 'ReferenceError' &&
          ["'text' is not defined", "'console' is not defined"].includes(message)
        )
          message =
            `${message} Code Mode has no console or standalone text/image helpers; use observe.text(value) or observe.image(value).`.slice(
              0,
              4096
            );
        const location = locateSource ? compilerSourceLocation(error, input.code) : '';
        if (location) message = message.slice(0, 4096 - location.length) + location;
        const code = message.includes('out of memory')
          ? 'MAR_AGENT_CODE_MEMORY_LIMIT'
          : syntaxError
            ? 'MAR_AGENT_CODE_SYNTAX_ERROR'
            : typeof error?.code === 'string'
              ? error.code
              : 'MAR_AGENT_CODE_FAILED';
        throw diagnostic(code, message);
      };
      const guestError = (code, message) => {
        const handle = vm.newError({ name: 'Error', message });
        const value = vm.newString(code);
        vm.setProp(handle, 'code', value);
        value.dispose();
        return handle;
      };
      const evalGuest = (...args) => runGuest(() => vm.evalCode(...args));
      const callGuest = (...args) => runGuest(() => vm.callFunction(...args));
      runtime.setModuleLoader(() => ({
        error: guestError('MAR_AGENT_CODE_IMPORT_DENIED', 'Module imports are unavailable.')
      }));
      const setup = evalGuest(`
        for (const name of ['console', 'process', 'require', 'module', 'Buffer', 'fetch',
          'WebSocket', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'text', 'image'])
          delete globalThis[name];
        globalThis.__parseJson = JSON.parse;
        globalThis.__serialize = (value, toolInput = false) => {
          let root = true;
          return JSON.stringify(value, function (_key, item) {
            const first = root;
            root = false;
            if (toolInput && !first && !Array.isArray(this) && typeof item === 'undefined')
              return undefined;
            if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof item))
              throw Object.assign(new TypeError('Only JSON values may cross the tool bridge.'),
                { code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
            return item;
          });
        };
        globalThis.__text = ${streamText.toString()};
        globalThis.__snapshot = (() => {
          const keys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor;
          const create = Object.create, stringify = JSON.stringify;
          return (value, errorSnapshot) => {
            const seen = create(null); let depth = 0;
            function walk(item) {
              if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return stringify(item);
              if (typeof item !== 'object') throw new Error('Not an original JSON object.');
              for (let i = 0; i < depth; i++) if (seen[i] === item) throw new Error('Cyclic object.');
              seen[depth++] = item;
              const names = keys(item); let text = '{';
              for (let i = 0; i < names.length; i++) {
                const name = names[i], field = descriptor(item, name);
                if (errorSnapshot && depth === 1 && name !== 'code' && name !== 'message' && name !== 'name') continue;
                if (typeof name !== 'string' || !field || !('value' in field)) throw new Error('Accessor object.');
                text += stringify(name) + ':' + Number(field.enumerable) + Number(field.writable) + Number(field.configurable) + walk(field.value) + ';';
              }
              depth--; return text + '}';
            }
            try { return walk(value); } catch { return ''; }
          };
        })();
        globalThis.__deepFreeze = function deepFreeze(value) {
          if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            for (const item of Object.values(value)) deepFreeze(item);
            Object.freeze(value);
          }
          return value;
        };
      `);
      if (setup.error) fail(setup.error);
      setup.value.dispose();
      const parseJson = vm.getProp(vm.global, '__parseJson');
      const serialize = vm.getProp(vm.global, '__serialize');
      const formatText = vm.getProp(vm.global, '__text');
      const snapshotFunction = vm.getProp(vm.global, '__snapshot');
      const snapshot = (handle, errorSnapshot = false) => {
        const value = callGuest(
          snapshotFunction,
          vm.undefined,
          handle,
          errorSnapshot ? vm.true : vm.false
        );
        if (value.error) {
          value.error.dispose();
          return '';
        }
        try {
          return vm.getString(value.value);
        } finally {
          value.value.dispose();
        }
      };
      const deepFreeze = vm.getProp(vm.global, '__deepFreeze');
      const parse = (value) => {
        const handle = vm.newString(JSON.stringify(value));
        try {
          const parsed = callGuest(parseJson, vm.undefined, handle);
          if (parsed.error) fail(parsed.error);
          return parsed.value;
        } finally {
          handle.dispose();
        }
      };
      const jsonValue = (handle, toolInput = false) => {
        const result = callGuest(serialize, vm.undefined, handle, toolInput ? vm.true : vm.false);
        if (result.error) return { error: result.error };
        try {
          return { value: JSON.parse(vm.getString(result.value)) };
        } finally {
          result.value.dispose();
        }
      };
      const method = (object, name, callback) => {
        const handle = vm.newFunction(name, callback);
        vm.setProp(object, name, handle);
        handle.dispose();
      };
      const key = (handle) => {
        if (!handle || vm.typeof(handle) !== 'string')
          return {
            error: guestError('MAR_AGENT_TOOL_INPUT_INVALID', 'State key must be a string.')
          };
        const value = vm.getString(handle);
        if (!value || Buffer.byteLength(value) > input.limits.stateKeyBytes)
          return {
            error: guestError('MAR_AGENT_TOOL_INPUT_INVALID', 'State key is invalid or too large.')
          };
        return { value };
      };
      const validateState = () => {
        if (state.size > input.limits.stateEntries)
          return guestError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Code Mode state has too many entries.');
        const entries = [...state].map(([entryKey, value]) => ({ key: entryKey, value }));
        if (Buffer.byteLength(JSON.stringify(entries)) > input.limits.stateTotalBytes)
          return guestError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Code Mode state is too large.');
      };

      const tools = vm.newObject();
      const parameterlessTools = new Set(
        input.catalog.filter(isParameterlessTool).map((tool) => tool.name)
      );
      let toolCallSequence = 0;
      for (const name of input.tools) {
        method(tools, name, (args = vm.undefined) => {
          const parsed =
            vm.typeof(args) === 'undefined' && parameterlessTools.has(name)
              ? { value: {} }
              : jsonValue(args, true);
          if (parsed.error) return parsed;
          const operationId = ++toolCallSequence;
          unconsumedToolCalls.add(operationId);
          const deferred = vm.newPromise();
          deferreds.add(deferred);
          const job = Promise.resolve()
            .then(() =>
              input.onToolCall({ name, arguments: parsed.value, callId: String(operationId) })
            )
            .then(
              (output) => {
                if (disposed || input.signal.aborted) return;
                runGuest(() => {
                  const handle = parse(output);
                  try {
                    const fingerprint = snapshot(handle);
                    origins.push({
                      handle: handle.dup(),
                      snapshot: fingerprint,
                      errorSnapshot: false,
                      operationId: String(operationId)
                    });
                    deferred.resolve(handle);
                  } finally {
                    handle.dispose();
                  }
                });
              },
              (error) => {
                if (disposed || input.signal.aborted) return;
                runGuest(() => {
                  const handle = vm.newError({
                    name: 'Error',
                    message: String(error?.message ?? error).slice(0, 4096)
                  });
                  try {
                    const code = vm.newString(
                      String(error?.code ?? 'MAR_AGENT_HOST_OPERATION_FAILED')
                    );
                    try {
                      vm.setProp(handle, 'code', code);
                    } finally {
                      code.dispose();
                    }
                    const fingerprint = snapshot(handle, true);
                    origins.push({
                      handle: handle.dup(),
                      snapshot: fingerprint,
                      errorSnapshot: true,
                      operationId: String(operationId)
                    });
                    deferred.reject(handle);
                  } finally {
                    handle.dispose();
                  }
                });
              }
            )
            .catch((error) => {
              bridgeFailure =
                error?.code === 'MAR_AGENT_CODE_TIMEOUT'
                  ? error
                  : diagnostic(
                      'MAR_AGENT_CODE_ENGINE_FAILED',
                      String(error?.message ?? error).slice(0, 4096)
                    );
            })
            .finally(() => {
              pending.delete(job);
              deferreds.delete(deferred);
              if (deferred.alive) deferred.dispose();
              notify();
            });
          pending.add(job);
          const operation = vm.newObject();
          const id = vm.newNumber(operationId);
          vm.setProp(operation, 'id', id);
          vm.setProp(operation, 'promise', deferred.handle);
          id.dispose();
          return operation;
        });
      }
      vm.setProp(vm.global, 'tools', tools);
      tools.dispose();
      const consumeToolCall = vm.newFunction('__consumeToolCall', (idHandle) => {
        if (idHandle && vm.typeof(idHandle) === 'number')
          unconsumedToolCalls.delete(vm.getNumber(idHandle));
        return vm.undefined;
      });
      vm.setProp(vm.global, '__consumeToolCall', consumeToolCall);
      consumeToolCall.dispose();

      const observeValue = (handle, kind) => {
        for (const origin of origins) {
          if (
            handle &&
            vm.eq(handle, origin.handle) &&
            origin.snapshot &&
            snapshot(handle, origin.errorSnapshot) === origin.snapshot
          ) {
            input.onObserve({ type: 'tool_result', operationId: origin.operationId });
            return vm.undefined;
          }
        }
        if (kind === 'result')
          return {
            error: guestError(
              'MAR_AGENT_TOOL_INPUT_INVALID',
              `observe.result requires an unmodified original tool result or error; received ${handle ? vm.typeof(handle) : 'undefined'}. Pass the awaited tools.NAME(...) result; use observe.text(value) for derived values.`
            )
          };
        // A standalone image is a value, never an original tool-result observation.
        if (kind === 'image') {
          const parsed = jsonValue(handle);
          if (parsed.error) return parsed;
          input.onObserve({ type: 'image', value: parsed.value });
          return vm.undefined;
        }
        const separatorBytes = textCalls ? 1 : 0;
        const capture = new BoundedTextOutput(
          Math.max(0, input.limits.outputBytes - outputBytes - separatorBytes),
          ''
        );
        const emit = vm.newFunction('textChunk', (chunk) => {
          if (!chunk || vm.typeof(chunk) !== 'string')
            return {
              error: guestError(
                'MAR_AGENT_TOOL_INPUT_INVALID',
                'Text output chunks must be strings.'
              )
            };
          const length = vm.getProp(chunk, 'length');
          const oversized = vm.getNumber(length) > 4096 * 6;
          length.dispose();
          if (oversized)
            return {
              error: guestError(
                'MAR_AGENT_TOOL_OUTPUT_LIMIT',
                'Text serialization chunk limit exceeded.'
              )
            };
          capture.append(vm.getString(chunk));
          return vm.undefined;
        });
        const result = callGuest(formatText, vm.undefined, handle ?? vm.undefined, emit);
        emit.dispose();
        if (result.error) return { error: result.error };
        try {
          const captured = capture.snapshot();
          outputBytes += captured.retainedBytes + separatorBytes;
          textCalls++;
          input.onObserve({
            type: 'value',
            format: handle && vm.typeof(handle) === 'object' ? 'json' : 'text',
            value: captured.text,
            originalBytes: captured.originalBytes
          });
        } finally {
          result.value.dispose();
        }
        return vm.undefined;
      };
      const observe = vm.newObject();
      for (const kind of ['result', 'text', 'image'])
        method(observe, kind, (handle) => observeValue(handle, kind));
      vm.setProp(vm.global, 'observe', observe);
      observe.dispose();

      const stateObject = vm.newObject();
      method(stateObject, 'get', (keyHandle) => {
        const parsed = key(keyHandle);
        if (parsed.error) return parsed;
        return state.has(parsed.value) ? parse(state.get(parsed.value)) : vm.undefined;
      });
      method(stateObject, 'has', (keyHandle) => {
        const parsed = key(keyHandle);
        if (parsed.error) return parsed;
        return state.has(parsed.value) ? vm.true : vm.false;
      });
      method(stateObject, 'set', (keyHandle, valueHandle = vm.undefined) => {
        const parsedKey = key(keyHandle);
        if (parsedKey.error) return parsedKey;
        const parsedValue = jsonValue(valueHandle);
        if (parsedValue.error) return parsedValue;
        if (Buffer.byteLength(JSON.stringify(parsedValue.value)) > input.limits.stateValueBytes)
          return { error: guestError('MAR_AGENT_TOOL_INPUT_INVALID', 'State value is too large.') };
        const previous = state.has(parsedKey.value)
          ? { exists: true, value: state.get(parsedKey.value) }
          : { exists: false };
        state.set(parsedKey.value, parsedValue.value);
        const invalid = validateState();
        if (invalid) {
          if (previous.exists) state.set(parsedKey.value, previous.value);
          else state.delete(parsedKey.value);
          return { error: invalid };
        }
        if (stateMutations.length >= input.limits.stateMutations) {
          if (previous.exists) state.set(parsedKey.value, previous.value);
          else state.delete(parsedKey.value);
          return {
            error: guestError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Too many state mutations.')
          };
        }
        stateMutations.push({ operation: 'set', key: parsedKey.value, value: parsedValue.value });
        return vm.undefined;
      });
      method(stateObject, 'delete', (keyHandle) => {
        const parsed = key(keyHandle);
        if (parsed.error) return parsed;
        if (!state.has(parsed.value)) return vm.false;
        if (stateMutations.length >= input.limits.stateMutations)
          return {
            error: guestError('MAR_AGENT_TOOL_OUTPUT_LIMIT', 'Too many state mutations.')
          };
        state.delete(parsed.value);
        stateMutations.push({ operation: 'delete', key: parsed.value });
        return vm.true;
      });
      vm.setProp(vm.global, 'state', stateObject);
      stateObject.dispose();

      const catalog = vm.newObject();
      method(catalog, 'tools', () => {
        const value = parse(
          input.catalog.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema
          }))
        );
        const frozen = callGuest(deepFreeze, vm.undefined, value);
        value.dispose();
        if (frozen.error) return { error: frozen.error };
        return frozen.value;
      });
      vm.setProp(vm.global, 'catalog', catalog);
      catalog.dispose();

      const cell = vm.newObject();
      method(cell, 'yield_control', () => {
        input.onYield();
        return vm.undefined;
      });
      method(cell, 'sleep', (durationHandle) => {
        if (!durationHandle || vm.typeof(durationHandle) !== 'number')
          return {
            error: guestError('MAR_AGENT_TOOL_INPUT_INVALID', 'Sleep duration must be an integer.')
          };
        const duration = vm.getNumber(durationHandle);
        if (!Number.isSafeInteger(duration) || duration < 0 || duration > input.limits.sleepMs)
          return {
            error: guestError('MAR_AGENT_TOOL_INPUT_INVALID', 'Sleep duration is out of range.')
          };
        const deferred = vm.newPromise();
        deferreds.add(deferred);
        let timer;
        const job = new Promise((resolve) => {
          timer = setTimeout(resolve, duration);
          sleepTimers.add(timer);
        })
          .then(() => {
            sleepTimers.delete(timer);
            if (!disposed && !input.signal.aborted) deferred.resolve(vm.undefined);
          })
          .catch((error) => {
            bridgeFailure = diagnostic(
              'MAR_AGENT_CODE_ENGINE_FAILED',
              String(error?.message ?? error).slice(0, 4096)
            );
          })
          .finally(() => {
            pending.delete(job);
            deferreds.delete(deferred);
            if (deferred.alive) deferred.dispose();
            notify();
          });
        pending.add(job);
        return deferred.handle;
      });
      vm.setProp(vm.global, 'cell', cell);
      cell.dispose();

      const lock = evalGuest(`
        const rawTools = globalThis.tools;
        const consumeToolCall = globalThis.__consumeToolCall;
        const wrappedTools = Object.fromEntries(Object.keys(rawTools).map(name => [name, (...args) => {
          const operation = rawTools[name](...args);
          const consume = () => consumeToolCall(operation.id);
          return Object.freeze({
            then(onFulfilled, onRejected) {
              consume();
              return operation.promise.then(onFulfilled, onRejected);
            },
            catch(onRejected) {
              consume();
              return operation.promise.catch(onRejected);
            },
            finally(onFinally) {
              consume();
              return operation.promise.finally(onFinally);
            }
          });
        }]));
        globalThis.tools = new Proxy(wrappedTools, { get(target, name) {
          if (name === 'then') return undefined;
          if (!Object.prototype.hasOwnProperty.call(target, name))
            return () => { throw Object.assign(new Error('The requested nested tool is unavailable.'),
              { code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' }); };
          return target[name];
        }});
        for (const name of ['tools', 'observe', 'state', 'catalog', 'cell']) {
          const value = globalThis[name];
          Object.freeze(value);
          Object.defineProperty(globalThis, name, {
            value, writable: false, configurable: false, enumerable: true
          });
        }
        delete globalThis.__parseJson;
        delete globalThis.__serialize;
        delete globalThis.__text;
        delete globalThis.__snapshot;
        delete globalThis.__deepFreeze;
        delete globalThis.__consumeToolCall;
      `);
      if (lock.error) fail(lock.error);
      lock.value.dispose();

      input.signal.addEventListener('abort', notify, { once: true });
      let main;
      try {
        const evaluated = evalGuest(`(async () => {\n${input.code}\n})()`, 'code-mode.js');
        if (evaluated.error) fail(evaluated.error, true);
        main = evaluated.value;
        for (;;) {
          input.signal.throwIfAborted();
          if (bridgeFailure) throw bridgeFailure;
          const jobs = runGuest(() => runtime.executePendingJobs(100));
          if (jobs.error) fail(jobs.error);
          jobs.dispose();
          if (budgetExceeded()) throw executionTimeout();
          const promiseState = runGuest(() => vm.getPromiseState(main));
          if (promiseState.type === 'rejected') fail(promiseState.error);
          if (promiseState.type === 'fulfilled') {
            promiseState.value.dispose();
            if (pending.size)
              throw diagnostic(
                'MAR_AGENT_CODE_INCOMPLETE',
                'Unawaited asynchronous operations remain; completed tool operations are not rolled back.'
              );
            if (unconsumedToolCalls.size)
              throw diagnostic(
                'MAR_AGENT_CODE_INCOMPLETE',
                'Tool calls must be awaited; completed tool operations are not rolled back.'
              );
            return { stateMutations };
          }
          if (runtime.hasPendingJob()) continue;
          if (!pending.size)
            throw diagnostic(
              'MAR_AGENT_CODE_INCOMPLETE',
              'JavaScript returned an unresolved promise without active operations.'
            );
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        input.signal.removeEventListener('abort', notify);
        disposed = true;
        for (const timer of sleepTimers) clearTimeout(timer);
        main?.dispose();
        for (const deferred of deferreds) if (deferred.alive) deferred.dispose();
        parseJson.dispose();
        serialize.dispose();
        formatText.dispose();
        snapshotFunction.dispose();
        for (const origin of origins) origin.handle.dispose();
        deepFreeze.dispose();
      }
    },
    async dispose() {
      disposed = true;
      if (context?.alive) context.dispose();
      if (runtime?.alive) runtime.dispose();
    }
  };
}

// Compiled inside the guest: stream bounded chunks, never build a complete serialized object.
function streamText(value, emit) {
  'use strict';
  const chunks = (text, quoted = false) => {
    if (quoted) emit('"');
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 4096);
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      )
        end--;
      const part = text.slice(start, end);
      emit(quoted ? JSON.stringify(part).slice(1, -1) : part);
      start = end;
    }
    if (quoted) emit('"');
  };
  if (
    value === null ||
    ['string', 'number', 'boolean', 'bigint', 'undefined'].includes(typeof value)
  ) {
    chunks(String(value));
    return;
  }
  const ancestors = new Set();
  const toJSONValue = (item, key) =>
    item && typeof item === 'object' && typeof item.toJSON === 'function' ? item.toJSON(key) : item;
  const write = (item, path) => {
    if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof item))
      throw Object.assign(
        new TypeError(
          `Only JSON values may be emitted; ${path} has type ${typeof item}. Omit optional fields or use null explicitly.`
        ),
        {
          code: 'MAR_AGENT_TOOL_INPUT_INVALID'
        }
      );
    if (item instanceof Number || item instanceof String || item instanceof Boolean)
      item = item.valueOf();
    if (item instanceof BigInt) throw new TypeError('BigInt objects cannot be emitted.');
    if (item === null) {
      emit('null');
      return;
    }
    if (typeof item === 'string') {
      chunks(item, true);
      return;
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      emit(JSON.stringify(item));
      return;
    }
    if (ancestors.has(item)) throw new TypeError('Cyclic values cannot be emitted.');
    ancestors.add(item);
    if (Array.isArray(item)) {
      emit('[');
      const length = item.length;
      for (let index = 0; index < length; index++) {
        if (index) emit(',');
        write(toJSONValue(item[index], String(index)) ?? null, `${path}[${index}]`.slice(0, 256));
      }
      emit(']');
    } else {
      emit('{');
      let first = true;
      const names = Object.keys(item);
      // Special-case view_image and native MCP image objects: text omits Base64; observe.image keeps pixels.
      const imagePayload =
        names.includes('mimeType') &&
        typeof item.mimeType === 'string' &&
        item.mimeType.startsWith('image/');
      for (const name of names) {
        const field = toJSONValue(item[name], name);
        if (field === undefined) continue;
        if (!first) emit(',');
        first = false;
        chunks(name, true);
        emit(':');
        write(
          imagePayload &&
            (name === 'dataBase64' || (name === 'data' && item.type === 'image')) &&
            typeof field === 'string'
            ? '[image payload omitted; use observe.image]'
            : field,
          `${path}[${JSON.stringify(name.slice(0, 64))}]`.slice(0, 256)
        );
      }
      emit('}');
    }
    ancestors.delete(item);
  };
  write(toJSONValue(value, ''), '$');
}

function compilerSourceLocation(error, source) {
  if (
    error?.name !== 'SyntaxError' ||
    error.fileName !== 'code-mode.js' ||
    !Number.isSafeInteger(error.lineNumber) ||
    error.lineNumber <= 1
  )
    return '';
  // QuickJS counts LF lines and Unicode code-point columns; the wrapper adds one LF line.
  const lines = source.split('\n');
  const line = error.lineNumber - 1;
  if (line > lines.length) return compilerCaret(source, source, true);
  const column = Number(
    typeof error.stack === 'string'
      ? error.stack.match(/^\s*at code-mode\.js:\d+:(\d+)(?:\n|$)/u)?.[1]
      : undefined
  );
  if (
    !Number.isSafeInteger(column) ||
    column < 1 ||
    column > Array.from(lines[line - 1]).length + 1
  ) {
    // Without a valid column, intra-LF-line separators make the original source line ambiguous.
    if (/[\r\u2028\u2029]/u.test(lines[line - 1].replace(/\r$/u, ''))) return '';
    const preceding = line > 1 ? lines.slice(0, line - 1).join('\n') + '\n' : '';
    return ` (code-mode.js:${preceding.split(/\r\n|[\r\n\u2028\u2029]/u).length})`;
  }
  const prefix = [
    ...lines.slice(0, line - 1),
    Array.from(lines[line - 1])
      .slice(0, column - 1)
      .join('')
  ].join('\n');
  return compilerCaret(source, prefix);
}

function compilerCaret(source, prefix, endOfInput = false) {
  const segments = prefix.split(/\r\n|[\r\n\u2028\u2029]/u);
  const line = segments.length;
  const column = Array.from(segments.at(-1)).length + 1;
  const character = source.slice(prefix.length)[Symbol.iterator]().next().value;
  // Source may contain credentials, commands or private code. Show only a punctuation token.
  const token = endOfInput
    ? '<end of input>'
    : character === undefined || /[\r\n\u2028\u2029]/u.test(character)
      ? '<end of line>'
      : /^[{}[\]():;,.=+*/?!<>|&%\-]$/u.test(character)
        ? character
        : '<character omitted>';
  const preview = '<source omitted>';
  return ` (code-mode.js:${line}${endOfInput ? ', end of input' : ''})\nSyntax location: line ${line}, column ${column}\n${line} | ${preview}${token}\n${' '.repeat(String(line).length)} | ${' '.repeat(preview.length)}^`;
}

function isParameterlessTool(tool) {
  if (tool.parameterless === true) return true;
  const schema = tool.inputSchema;
  return (
    tool.inputMode === 'json' &&
    schema?.type === 'object' &&
    schema.additionalProperties === false &&
    schema.properties !== null &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties) &&
    Object.keys(schema.properties).length === 0 &&
    (schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(schema).every((key) =>
      [
        'type',
        'properties',
        'additionalProperties',
        'required',
        'title',
        'description',
        '$schema',
        '$comment'
      ].includes(key)
    )
  );
}

function diagnostic(code, message) {
  return Object.assign(new Error(message), { code });
}
