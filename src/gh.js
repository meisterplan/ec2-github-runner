const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const config = require('./config');

const INITIAL_WAIT_TIME_BEFORE_CHECKS = 4 * 1000; // 5 seconds
const MAX_WAIT_TIME_BEFORE_FAIL = 15 * 60 * 1000; // 15 minutes
const MAX_WAIT_TIME_BETWEEN_REGISTERED_CHECKS = 60 * 1000; // 60 seconds

// use the unique label to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunner(runnerId) {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const runners = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', config.githubContext);
    const foundRunners = _.filter(runners, (runner) => runner.name === runnerId);
    return foundRunners.length > 0 ? foundRunners[0] : null;
  } catch (error) {
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/runners/registration-token', config.githubContext);
    core.info('GitHub Registration Token is received');
    return response.data.token;
  } catch (error) {
    core.error('GitHub Registration Token receiving error');
    throw error;
  }
}

async function removeRunner() {
  const runner = await getRunner(config.input.ec2InstanceId ? config.input.ec2InstanceId : config.input.label);
  const octokit = github.getOctokit(config.input.githubToken);

  // skip the runner removal process if the runner is not found
  if (!runner) {
    core.info(`GitHub self-hosted runner with id ${config.input.label} is not found, so the removal is skipped`);
    return;
  }

  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', _.merge(config.githubContext, { runner_id: runner.id }));
    core.info(`GitHub self-hosted runner ${runner.name} is removed`);
    return;
  } catch (error) {
    core.error('GitHub self-hosted runner removal error');
    throw error;
  }
}

function waitForRunnerRegisteredRecursive(runnerId, resolve, reject, nextDelay, timeoutAfter) {
  core.info(`Waiting ${nextDelay / 1000} seconds...`);
  setTimeout(async () => {
    const runner = await getRunner(runnerId);
    if (runner && runner.status === 'online') {
      core.info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
      resolve();
    } else {
      if (timeoutAfter < new Date().getTime()) {
        core.error('GitHub self-hosted runner registration error');
        reject(`Timeout exceeded: Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`);
      } else {
        const waitFor = Math.min(nextDelay * 1.5, MAX_WAIT_TIME_BETWEEN_REGISTERED_CHECKS);
        waitForRunnerRegisteredRecursive(runnerId, resolve, reject, waitFor, timeoutAfter);
      }
    }
  }, nextDelay);
}

function waitForRunnerRegistered(runnerId) {
  core.info(`Checking if the GitHub self-hosted runner is registered, waiting up to ${Math.round(MAX_WAIT_TIME_BEFORE_FAIL / 1000 / 60)} minutes.`);

  return new Promise((resolve, reject) => {
    waitForRunnerRegisteredRecursive(runnerId, resolve, reject, INITIAL_WAIT_TIME_BEFORE_CHECKS, new Date().getTime() + MAX_WAIT_TIME_BEFORE_FAIL);
  });
}

module.exports = {
  getRegistrationToken,
  removeRunner,
  waitForRunnerRegistered,
};
