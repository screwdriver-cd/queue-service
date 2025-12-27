--[[
    startBuild.lua - Atomic build start check

    This script atomically checks if a build can start and updates Redis state accordingly.

    ARGV[1]  = buildId (string)
    ARGV[2]  = jobId (string)
    ARGV[3]  = blockedBy (JSON array string, e.g., "[123, 456]" or "[]")
    ARGV[4]  = collapseEnabled (string: "true" or "false")
    ARGV[5]  = blockedBySelf (string: "true" or "false")
    ARGV[6]  = queuePrefix (string, e.g., "buildConfig_")
    ARGV[7]  = runningJobsPrefix (string, e.g., "running_job_")
    ARGV[8]  = waitingJobsPrefix (string, e.g., "waiting_job_")
    ARGV[9]  = blockTimeout (number, in minutes, e.g., 90)

    Returns: JSON string with decision
    {
        action: "START" | "BLOCK" | "COLLAPSE" | "ABORT",
        reason: string,
        buildId: string,
        data: {...}
    }
]]

local buildId = ARGV[1]
local jobId = ARGV[2]
local blockedByJson = ARGV[3]
local collapseEnabled = ARGV[4] == "true"
local blockedBySelf = ARGV[5] == "true"
local queuePrefix = ARGV[6]
local runningJobsPrefix = ARGV[7]
local waitingJobsPrefix = ARGV[8]
local blockTimeout = tonumber(ARGV[9])

local buildConfigKey = queuePrefix .. "buildConfigs"
local runningKey = runningJobsPrefix .. jobId
local lastRunningKey = "last_" .. runningJobsPrefix .. jobId
local waitingKey = waitingJobsPrefix .. jobId
local deleteKey = "deleted_" .. jobId .. "_" .. buildId

local buildConfig = redis.call("HGET", buildConfigKey, buildId)
local runningBuildId = redis.call("GET", runningKey)
local waitingBuilds = redis.call("LRANGE", waitingKey, 0, -1)
local lastRunningBuildId = redis.call("GET", lastRunningKey)
local deleteKeyExists = redis.call("EXISTS", deleteKey)

-- Early exit: If buildConfig doesn't exist, build was already processed/deleted
-- Clean up any remaining state and abort
if not buildConfig then
    redis.log(redis.LOG_WARNING, string.format(
        "[startBuild] BUILD_CONFIG_MISSING: build=%s job=%s - buildConfig deleted externally",
        buildId, jobId
    ))

    redis.call("LREM", waitingKey, 0, buildId)
    redis.call("DEL", deleteKey)

    -- If this build is somehow marked as running, clean that up too
    if runningBuildId and tostring(runningBuildId) == tostring(buildId) then
        redis.call("DEL", runningKey)
    end
    if lastRunningBuildId and tostring(lastRunningBuildId) == tostring(buildId) then
        redis.call("DEL", lastRunningKey)
    end

    return cjson.encode({
        action = "ABORT",
        reason = "BUILD_CONFIG_MISSING",
        buildId = buildId
    })
end

-- Check if build was aborted (deleteKey exists)
local isAborted = (deleteKeyExists == 1)

-- Parse blockedBy dependencies
local blockedBy = cjson.decode(blockedByJson)
local dependencies = {}
if type(blockedBy) == "table" and #blockedBy > 0 then
    dependencies = blockedBy
elseif blockedBy then
    dependencies = {blockedBy}
end

-- Check which dependencies are currently running
local runningBuilds = {}
local runningJobIds = {}
for _, depJobId in ipairs(dependencies) do
    local depRunningBuild = redis.call("GET", runningJobsPrefix .. tostring(depJobId))
    if depRunningBuild then
        table.insert(runningBuilds, depRunningBuild)
        table.insert(runningJobIds, depJobId)
    end
end

-- Helper: Check if blocked by dependencies
-- Returns: isBlocked (boolean), blockedByBuilds (array of buildIds that are blocking)
local function isBlockedByDependencies(runningBuildIds)
    return #runningBuildIds > 0, runningBuildIds
end

-- Helper: Check if blocked by same job
local function isBlockedBySameJob()
    if not blockedBySelf then
        return false
    end
    if not runningBuildId then
        return false
    end
    local runningId = tonumber(runningBuildId)
    local currentId = tonumber(buildId)
    return runningId ~= currentId
end

-- Helper: Check if should collapse
local function shouldCollapse()
    if not collapseEnabled then
        return false, nil, "COLLAPSE_DISABLED"
    end

    if not waitingBuilds or #waitingBuilds == 0 then
        return false, nil, "NO_WAITING_BUILDS"
    end

    local newestBuild = tonumber(waitingBuilds[#waitingBuilds])
    local currentBuild = tonumber(buildId)

    -- Check if older than last running build
    if lastRunningBuildId then
        local lastRunning = tonumber(lastRunningBuildId)
        if currentBuild < lastRunning then
            return true, newestBuild, "OLDER_THAN_LAST_RUNNING"
        end
    end

    -- Check if not the newest waiting build
    if currentBuild < newestBuild then
        return true, newestBuild, "NEWER_BUILD_EXISTS"
    end

    return false, nil, "IS_NEWEST_BUILD"
end

local isBlockedByDeps, blockedByBuilds = isBlockedByDependencies(runningBuilds)
local isBlockedBySelf = isBlockedBySameJob()
local shouldCollapseFlag, newestBuild, collapseReason = shouldCollapse()

redis.log(redis.LOG_NOTICE, string.format(
    "[startBuild] build=%s job=%s deps=%d blockedByDeps=%s blockedBySelf=%s runningBuildId=%s lastRunning=%s shouldCollapse=%s deleteKeyExists=%s",
    buildId, jobId, #dependencies, tostring(isBlockedByDeps), tostring(isBlockedBySelf),
    tostring(runningBuildId or "nil"), tostring(lastRunningBuildId or "nil"),
    tostring(shouldCollapseFlag), tostring(deleteKeyExists == 1)
))

-- Determine final action (Priority: ABORT > COLLAPSE > BLOCK > START)
local action, reason, actionData

if isAborted then
    action = "ABORT"
    reason = "BUILD_ABORTED"

elseif shouldCollapseFlag then
    action = "COLLAPSE"
    reason = collapseReason
    actionData = {newestBuild = newestBuild}

elseif isBlockedByDeps then
    action = "BLOCK"
    reason = "BLOCKED_BY_DEPENDENCIES"
    actionData = {blockedBy = blockedByBuilds}

elseif isBlockedBySelf then
    action = "BLOCK"
    reason = "BLOCKED_BY_SAME_JOB"
    actionData = {runningBuildId = runningBuildId}

else
    action = "START"
    reason = "READY"
end

-- Update Redis state based on decision
if action == "ABORT" then
    -- Build was aborted - clean up waiting queue and configs
    redis.call("HDEL", buildConfigKey, buildId)
    redis.call("LREM", waitingKey, 0, buildId)
    redis.call("DEL", deleteKey)

    return cjson.encode({
        action = "ABORT",
        reason = reason,
        buildId = buildId
    })

elseif action == "COLLAPSE" then
    -- Collapse this build - remove from configs and waiting queue
    redis.log(redis.LOG_NOTICE, string.format(
        "[startBuild] COLLAPSE: Deleting buildConfig for build=%s job=%s reason=%s",
        buildId, jobId, reason
    ))
    redis.call("HDEL", buildConfigKey, buildId)
    redis.call("LREM", waitingKey, 0, buildId)

    return cjson.encode({
        action = "COLLAPSE",
        reason = reason,
        buildId = buildId,
        newestBuild = actionData.newestBuild
    })

elseif action == "BLOCK" then
    -- Build is blocked - add to waiting queue if not already there
    local alreadyWaiting = false
    for _, waitingBuildId in ipairs(waitingBuilds) do
        if tostring(waitingBuildId) == tostring(buildId) then
            alreadyWaiting = true
            break
        end
    end

    if not alreadyWaiting then
        redis.call("RPUSH", waitingKey, buildId)
    end

    return cjson.encode({
        action = "BLOCK",
        reason = reason,
        buildId = buildId,
        blockedBy = actionData and actionData.blockedBy or nil,
        runningBuildId = actionData and actionData.runningBuildId or nil
    })

else  -- START
    -- Build can start - update running keys and clean up
    redis.call("SET", runningKey, buildId, "EX", blockTimeout * 60)
    redis.call("SET", lastRunningKey, buildId, "EX", blockTimeout * 60 * 2)

    -- Remove from waiting queue if present
    redis.call("LREM", waitingKey, 0, buildId)

    -- Delete the deleteKey (no longer needed)
    redis.call("DEL", deleteKey)

    return cjson.encode({
        action = "START",
        reason = reason,
        buildId = buildId
    })
end
