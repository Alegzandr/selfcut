/**
 * Which part of a message the browser refuses to copy.
 *
 * `postMessage` reports a failed structured clone as one sentence about the
 * whole message - Safari's is "The object can not be cloned." - and says
 * nothing about which value in it was the problem. That is a fine error for the
 * engine to raise and a useless one to receive: what does not clone differs by
 * browser (an `ImageBitmap` copies in Chromium and not in WebKit, a stream
 * copies nowhere), so the failure lands on the machines the author does not
 * have, in a message that names nothing to go and look at.
 *
 * So when a send fails, the message is walked one value at a time and the path
 * to the first value the browser refuses is what gets reported. Only ever run
 * on the failure path: copying a whole export request to find out that it
 * copies is exactly the copy the message was trying to avoid.
 *
 * The walk asks a `MessagePort` rather than `structuredClone`, because those
 * two are not always the same answer - an engine can hold a value clonable and
 * still refuse to put it through a port - and the port is the algorithm that
 * just said no.
 */

/** How deep to descend before reporting the container rather than its contents. */
const MAX_DEPTH = 12;

/**
 * A `clones(value)` predicate, and the ports it borrows to answer with.
 * Both are closed by the caller: a port left open is a live task source.
 */
function openProbe(): { clones: (value: unknown) => boolean; close: () => void } {
  if (typeof MessageChannel === 'undefined') {
    return { clones: (value) => tryIt(() => structuredClone(value)), close: () => undefined };
  }
  const channel = new MessageChannel();
  return {
    // Nothing ever reads port2, so the message is serialized (which is where a
    // refusal is raised) and then dropped.
    clones: (value) => tryIt(() => channel.port1.postMessage(value)),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function tryIt(send: () => void): boolean {
  try {
    send();
    return true;
  } catch {
    return false;
  }
}

/**
 * The path to the first value in `message` that this browser cannot structurally
 * clone (`'fileHandle'`, `'files.a3f9'`, `'project.luts.0.table'`), or null when
 * the whole thing clones.
 *
 * The path is dotted and array indices are plain numbers, which is enough to
 * find the value in a debugger or in this codebase, and short enough to put in
 * front of a user who is about to report it.
 */
export function firstUncloneable(message: unknown): string | null {
  const probe = openProbe();
  try {
    return walk(message, probe.clones, '', 0);
  } finally {
    probe.close();
  }
}

function walk(
  message: unknown,
  clones: (value: unknown) => boolean,
  path: string,
  depth: number,
): string | null {
  if (clones(message)) return null;
  // Something in here does not clone. If it is a container, the useful answer is
  // inside it; the container's own name is the answer only when nothing in it
  // can be blamed - a plain unclonable value, or one nested past MAX_DEPTH.
  if (message && typeof message === 'object' && depth < MAX_DEPTH) {
    for (const [key, value] of Object.entries(message)) {
      const found = walk(value, clones, path ? `${path}.${key}` : key, depth + 1);
      if (found !== null) return found;
    }
  }
  return path || '(the message itself)';
}
