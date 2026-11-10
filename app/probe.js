import net from "node:net";

export function isListening(port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "localhost", port, autoSelectFamily: true });
    const done = (value) => {
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeout, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}
