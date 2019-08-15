'use strict';
require('dotenv').config();
const process = require('process');
const chalk = require('chalk');
const csprng = require('random-number-csprng');
const log = require('loglevel');
const logprefix = require('loglevel-plugin-prefix');
const MongoClient = require('mongodb').MongoClient;
const FurAffinity = require('./lib/furaffinity.js');
const packageInfo = require('./package.json');

var dbClient = new MongoClient(`mongodb://${process.env.DB_HOST}/`, {useNewUrlParser: true});
var faClient = new FurAffinity(process.env.FA_A_TOKEN, process.env.FA_B_TOKEN);
var db, configCol, submissionsCol;

setupLogger();

if (!process.env.FA_A_TOKEN || !process.env.FA_B_TOKEN) {
  log.warn('FA token(s) missing! Adult content will not be collected');
}

main();

async function main() {
  log.info(`OpenFur Data Collector v${packageInfo.version}`);
  log.info('-----------------------------');
  
  await dbClient.connect();
  db = dbClient.db(process.env.DB_NAME);
  configCol = db.collection('config');
  submissionsCol = db.collection('submissions');
  log.info('Connected to database');

  let year = (new Date()).getFullYear() - 1;
  log.info(`Downloading data for year: ${year}`);
  
  let ranges = await configCol.findOne({year: year});
  if (!ranges) {
    log.info('No range information in database (first run?)');
    ranges = await lookupRanges(year);
    await configCol.insertOne({year: year, ...ranges});
  }
  
  let targetEntries = Math.floor((ranges.lastPost - ranges.firstPost) * 0.1);
  let currentEntries = await submissionsCol.countDocuments({
    date: {
      "$gte": new Date(year + '-01-01T00:00:00Z'),
      "$lte": new Date(year + '-12-31T23:59:00Z')
    }
  });
  
  log.info('Current Entries:', currentEntries, '- Target:', targetEntries);
  
  for (let i = currentEntries; i < targetEntries;) {
    let randomId = await csprng(ranges.firstPost, ranges.lastPost);
    if ((await submissionsCol.countDocuments({id: randomId})) === 0) {
      let postMeta = await faClient.fetchPostMeta(randomId);
      if (postMeta) {
        await submissionsCol.insertOne(postMeta);
        i++;
        log.info(`Downloaded metadata (${i}/${targetEntries}): ${JSON.stringify(postMeta)}`);
      }
    }
  }
  
  log.info('Download complete :)');
  
  log.info('Closing database');
  await dbClient.close();
}

async function lookupRanges(year) {
  log.info('Looking up latest FA post...');
  await faClient.findLatestPost();
  
  log.info('Looking up first post of the previous year... (this\'ll take a while)');
  let firstPost = await faClient.findPostByDate(new Date(year + '-01-01T00:00:00Z'), true);
  log.info('First post found:', firstPost);
  
  log.info('Looking up last post of the previous year... (this\'ll take a while)');
  let lastPost = await faClient.findPostByDate(new Date(year + '-12-31T23:59:00Z'), false);
  log.info('Last post found:', lastPost);
  
  return {firstPost, lastPost};
}

function setupLogger() {
  logprefix.reg(log);
  log.enableAll();
  log.getLogger('FurAffinity-lib').enableAll();
  //log.getLogger('FurAffinity-lib').setLevel('warning');
  
  let colors = {
    TRACE: chalk.magenta,
    DEBUG: chalk.cyan,
    INFO: chalk.blue,
    WARN: chalk.yellow,
    ERROR: chalk.red,
  };

  logprefix.apply(log, {
    format(level, name, timestamp) {
      return `${chalk.gray(`[${timestamp}]`)} ${colors[level.toUpperCase()](level)} ${chalk.green(`${name}:`)}`;
    },
  });
  
  logprefix.apply(log.getLogger('FurAffinity-lib'));
}
