'use strict';
require('dotenv').config();
const fs = require('fs');
const process = require('process');
const chalk = require('chalk');
const log = require('loglevel');
const logprefix = require('loglevel-plugin-prefix');
const MongoClient = require('mongodb').MongoClient;
const natural = require('natural');

const nsfwList = require('./lists/nsfw.json');
const typesList = require('./lists/types.json');
const packageInfo = require('./package.json');

var tokenizer = new natural.WordTokenizer();
var dbClient = new MongoClient(`mongodb://${process.env.DB_HOST}/`, {useNewUrlParser: true});
var db, configCol, submissionsCol;

setupLogger();
main();

async function main() {
  log.info(`OpenFur Data Analyzer v${packageInfo.version}`);
  log.info('-----------------------------');
  
  await dbClient.connect();
  db = dbClient.db(process.env.DB_NAME);
  configCol = db.collection('config');
  submissionsCol = db.collection('submissions');
  log.info('Connected to database');
  
  let year = (new Date()).getFullYear() - 1;
  log.info(`Analyzing dataset for year: ${year}`);
  
  let ranges = await configCol.findOne({year: year});
  if (!ranges) {
    log.error('No range information in database. This should be set by the collector tool');
    return;
  }
  
  let total = await submissionsCol.countDocuments();
  
  log.info(`Total number of posts to process: ${total}`);
  log.info('Beginning report generation');

  let report = {};
  let ratings = {};
  let progress = 0;
  
  ['all', 'general', 'mature', 'adult'].forEach((rating) => {
    report[rating] = {total: 0, nsfwTotal: 0};
    ratings[rating] = {nsfwTypeTotals: {}, tagTotals: {}, themeTotals: {}};
  });
  
  let cursor = await submissionsCol.find({
    date: {
      "$gte": new Date(year + '-01-01T00:00:00Z'),
      "$lte": new Date(year + '-12-31T23:59:00Z')
    }
  });

  while (await cursor.hasNext()) {
    let submission = await cursor.next();
    let rating = submission.rating;
    let nsfw =  possiblyNsfw(submission);
    
    let oldProgress = progress;
    progress = Math.floor((report.all.total / total) * 100 / 10);
    if (oldProgress !== progress) {
      log.info(`Aggregation progress: ${progress * 10}%`);
    } 
    
    // General totals
    report.all.total++;
    report[rating].total++;
    if (nsfw) {
      report.all.nsfwTotal++;
      report[rating].nsfwTotal++;
    }
    
    // Tags count
    for (let i = 0; i < submission.tags.length; i++) {
      let tag = submission.tags[i] = submission.tags[i].toLowerCase();
      ratings[rating].tagTotals[tag] ? ratings[rating].tagTotals[tag]++ : ratings[rating].tagTotals[tag] = 1;
      ratings.all.tagTotals[tag] ? ratings.all.tagTotals[tag]++ : ratings.all.tagTotals[tag] = 1;
    }
    
    // Theme count
    if (submission.theme) {
      let theme = submission.theme = submission.theme.toLowerCase();
      ratings[rating].themeTotals[theme] ? ratings[rating].themeTotals[theme]++ : ratings[rating].themeTotals[theme] = 1;
      ratings.all.themeTotals[theme] ? ratings.all.themeTotals[theme]++ : ratings.all.themeTotals[theme] = 1;
    }
    
    // Content typing
    if (nsfw) {
      let nsfwTypes = processNsfwTypes(submission);
      for (let i = 0; i < nsfwTypes.length; i++) {
        let type = nsfwTypes[i];
        ratings.all.nsfwTypeTotals[type] ? ratings.all.nsfwTypeTotals[type]++ : ratings.all.nsfwTypeTotals[type] = 1;
      }
    }
  }
  
  log.info('Raw aggregations done');
  
  log.info('Closing database');
  await dbClient.close();
  
  log.info('Beginning post-processing');
  
  for (let rating in ratings) {
    log.debug(`Post-processing ${rating} data`);

    // Process tags
    let topTags = [];
    for (let tag in ratings[rating].tagTotals) {
      if (ratings[rating].tagTotals[tag] <= 5) continue;
      topTags.push({total: ratings[rating].tagTotals[tag], tag})
    };
    topTags.sort((a, b) =>  b.total - a.total);
    report[rating].topTags = topTags.slice(0, 200);
    
    log.debug(`Processed tags for ${rating}`);
    
    // Process themes
    let topThemes = [];
    for (let theme in ratings[rating].themeTotals) {
      if (ratings[rating].themeTotals[theme] <= 5) continue;
      topThemes.push({total: ratings[rating].themeTotals[theme], theme});
    }
    topThemes.sort((a, b) =>  b.total - a.total);
    report[rating].topThemes = topThemes.slice(0, 200);
    
    log.debug(`Processed themes for ${rating}`);
  }
  
  let nsfwTypes = [];
  for (let nsfwType in ratings.all.nsfwTypeTotals) {
    nsfwTypes.push({total: ratings.all.nsfwTypeTotals[nsfwType], nsfwType});
  }
  nsfwTypes.sort((a, b) =>  b.total - a.total);
  report.all.nsfwTypes = nsfwTypes;
  
  log.debug('Processed nsfw types');
  
  log.info('Writing report out to report.json');
  fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
}

function possiblyNsfw(submission) {
  if (submission.rating === 'adult') return true;
  
  let titleTokens = submission.title ? tokenizer.tokenize(submission.title.toLowerCase()) : [];
  let descriptionTokens = submission.description ? tokenizer.tokenize(submission.description.toLowerCase()) : [];
  
  for (let i = 0; i < nsfwList.tags.length; i++) {
    if (submission.tags.includes(nsfwList.tags[i])) return true;
    if (titleTokens.includes(nsfwList.tags[i])) return true;
    if (descriptionTokens.includes(nsfwList.tags[i])) return true;
  }
  
  for (let i = 0; i < nsfwList.themes.length; i++) {
    if (submission.theme  === nsfwList.themes[i]) return true;
  }
  
  return false;
}

function processNsfwTypes(submission) {
  let matchedTypes = [];
  let types = Object.keys(typesList);
  
  for (let i = 0; i < types.length; i++) {
    let type = types[i];
    let matched = false;
    
    // Tag match
    for (let j = 0; j < typesList[type].tags.length; j++) {
      let tag = typesList[type].tags[j];
      let titleTokens = submission.title ? tokenizer.tokenize(submission.title.toLowerCase()) : [];
      let descriptionTokens = submission.description ? tokenizer.tokenize(submission.description.toLowerCase()) : [];
      
      if (submission.tags.includes(tag) || titleTokens.includes(tag) || descriptionTokens.includes(tag)) {
        matchedTypes.push(type);
        matched = true;
        break;
      }
    }
    
    if (matched) continue;
    
    // Theme match
    for (let j = 0; j < typesList[type].themes.length; j++) {
      let theme = typesList[type].themes[j];
      
      if (submission.theme === theme) {
        matchedTypes.push(type);
        break;
      }
    }
  }
  
  return matchedTypes;
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
