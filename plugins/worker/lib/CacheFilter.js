'use strict';

const NodeResque = require('node-resque');

class CacheFilter extends NodeResque.Plugin {
    /**
     * Construct a new Filter plugin
     * @method constructor
     */
    constructor(worker, func, queue, job, args, options) {
        super(worker, func, queue, job, args, options);

        this.name = 'CacheFilter';
    }

    /**
     * Checks if the job is a cache invalidation job
     * @method beforePerform
     * @return {Promise}
     */
    async beforePerform() {
        const { id, resource } = this.args[0];

        if (!id || resource !== 'caches') {
            return false;
        }

        return true;
    }
}

exports.CacheFilter = CacheFilter;
