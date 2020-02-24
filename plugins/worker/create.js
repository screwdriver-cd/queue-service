'use strict';

const worker = require('./worker');

module.exports = () => ({
    method: 'POST',
    path: '/queue/worker',
    config: {
        description: 'Reads and process a message from the queue',
        notes: 'Should process a message from the queue',
        tags: ['api', 'queue'],
        handler: async (request, h) => {
            const result = await worker.invoke(request);

            return h.response(result).code(200);
        }
    }
});
