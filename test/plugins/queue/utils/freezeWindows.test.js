'use strict';

const { assert } = require('chai');
const { timeOutOfWindows } = require('../../../../plugins/queue/utils/freezeWindows.js');

describe('freeze windows', () => {
    it('should return the correct date outside the freeze windows', () => {
        const currentDate = new Date(Date.UTC(2018, 10, 24, 10, 33));

        timeOutOfWindows(['0-31,33-35 * * * ?', '* 5-23 * * ?', '* * ? 11 *', '* * ? * 6'], currentDate);

        const expectedDate = new Date('2018-12-02T00:32:00.000Z');

        assert.equal(currentDate.getTime(), expectedDate.getTime());
    });

    it('should return the same date if outside the freeze windows', () => {
        const currentDate = new Date(Date.UTC(2018, 10, 24, 10, 33));

        timeOutOfWindows(['0-31,34-35 * * * ?', '* 11-17 * * ?', '* * ? 10 *', '* * ? * 4'], currentDate);

        const expectedDate = new Date('2018-11-24T10:33:00.000Z');

        assert.equal(currentDate.getTime(), expectedDate.getTime());
    });

    it('should return the same date if outside the freeze windows for correct days of week', () => {
        const currentDate = new Date(Date.UTC(2020, 2, 13, 21, 6));

        timeOutOfWindows(
            [
                '* 0-14,21-23 ? * 1-4',
                '* * ? * 0,5-6',
                '* * 01 01 ?',
                '* * 20 01 ?',
                '* * 25 05 ?',
                '* * 03 07 ?',
                '* * 04 07 ?',
                '* * 07 09 ?',
                '* * 28,29 11 ?',
                '* * 26,27 11 ?',
                '* * 25 12 ?'
            ],
            currentDate
        );
        const expectedDate = new Date('2020-03-16T15:00:00.000Z');

        assert.equal(currentDate.toUTCString(), expectedDate.toUTCString());
    });

    it('should be equal to first date after freeze windows when day of week is specified', () => {
        const currentDate = new Date(Date.UTC(2020, 2, 13, 21, 6));

        timeOutOfWindows(['* * ? * 0,5-6', '* 0-17,19-23 ? * 1-4'], currentDate);

        const expectedDate = new Date('2020-03-16T18:00:00.000Z');

        assert.equal(currentDate.toUTCString(), expectedDate.toUTCString());
    });

    it('should be equal to first date after freeze windows when day of month is specified', () => {
        const currentDate = new Date(Date.UTC(2020, 3, 1, 15, 57));

        timeOutOfWindows(['* * 6 4 ?', '* * ? * 0,4-6', '* 0-13,15-23 ? * 1-3'], currentDate);

        const expectedDate = new Date('2020-04-07T14:00:00.000Z');

        assert.equal(currentDate.toUTCString(), expectedDate.toUTCString());
    });

    it('should return the same date if outside the freeze windows for correct days of week', () => {
        const currentDate = new Date(Date.UTC(2020, 3, 4, 14, 0));

        timeOutOfWindows(
            [
                '* 0-13 * * ?',
                '* * ? * 0,5-6',
                '* * 1 2,3,5,6,8,9,11,12 ?',
                '* * 31 1,5,7,8,10 ?',
                '* * 30 4,11 ?',
                '* * 28 2 ?',
                '* * 29 2 ?',
                '* * 30-31 3,12 ?',
                '* * 29-30 6,9 ?',
                '* * 1-2 1,4,7,10 ?',
                '* * 01 01 ?',
                '* * 20 01 ?',
                '* * 22 05 ?',
                '* * 03 07 ?',
                '* * 07 09 ?',
                '* * 26-27 11 ?',
                '* * 25 12 ?'
            ],
            currentDate
        );
        const expectedDate = new Date('2020-04-06T14:00:00.000Z');

        assert.equal(currentDate.toUTCString(), expectedDate.toUTCString());
    });

    it('should return the correct date in gmt', () => {
        const currentDate = new Date(Date.UTC(2020, 3, 4, 14, 26));

        timeOutOfWindows(
            [
                '* 1-13 * * ?',
                '* * ? * 0,5-6',
                '* * 1 2,3,5,6,8,9,11,12 ?',
                '* * 31 1,5,7,8,10 ?',
                '* * 30 4,11 ?',
                '* * 28 2 ?',
                '* * 29 2 ?',
                '* * 30-31 3,12 ?',
                '* * 29-30 6,9 ?',
                '* * 1-2 1,4,7,10 ?',
                '* * 01 01 ?',
                '* * 20 01 ?',
                '* * 22 05 ?',
                '* * 03 07 ?',
                '* * 07 09 ?',
                '* * 26-27 11 ?',
                '* * 25 12 ?'
            ],
            currentDate
        );
        const expectedDate = new Date('2020-04-06T00:00:00.000Z');

        assert.equal(currentDate.toUTCString(), expectedDate.toUTCString());
    });
});
