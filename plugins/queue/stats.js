'use strict';

module.exports = () => ({
    method: 'GET',
    path: '/queue/stats',
    config: {
        description: 'Gets the stats from the queue',
        notes: 'Should get the stats from the queue',
        tags: ['api', 'queue', 'stats'],
        handler: async (request, h) => {
            const stats = request.server.app.executorQueue.stats();

            return h.response(stats).code(200);
        }
    }
});
