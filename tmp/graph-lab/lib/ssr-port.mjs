import http from 'node:http';

// Preloaded into an SSR bundle (node --import): the bundle always listens on Inertia's default port, 13714, which
// GLAB_SSR_PORT replaces, so several versions can render side by side.

const port = Number(process.env.GLAB_SSR_PORT);
const listen = http.Server.prototype.listen;

http.Server.prototype.listen = function (options, ...rest) {
    const moved = options !== null && typeof options === 'object' && options.port === 13714 ? { ...options, port } : options;

    return listen.call(this, moved, ...rest);
};
