/**
 * Exactly the mediabunny surface the MAIN THREAD uses, and nothing else.
 *
 * `import('mediabunny')` would defer the module but also defeat tree-shaking:
 * the bundler cannot see which of its exports a destructured await touches, so
 * the deferred chunk ends up carrying the muxers, the encoders and every
 * container writer the editor's preview side never calls. Naming the five
 * symbols here gives the bundler the same static view it had when the import
 * was eager, so the chunk that is deferred is also the smallest one possible.
 *
 * The workers do not go through this: each is its own bundle and each uses a
 * different slice of the library.
 */
export { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
