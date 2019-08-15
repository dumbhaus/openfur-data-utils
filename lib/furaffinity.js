'use strict';
const process = require('process');
const axios = require('axios').default;
const axiosCookieJarSupport = require('axios-cookiejar-support').default;
const Bottleneck = require('bottleneck/es5');
const cheerio = require('cheerio');
const log = require('loglevel').getLogger('FurAffinity-lib');
const tough = require('tough-cookie');

const limiter = new Bottleneck({minTime: 100, maxConcurrent: 1});

module.exports = class FurAffinity {
  constructor(aToken, bToken) {
    this.axiosInstance = axios.create();
    axiosCookieJarSupport(this.axiosInstance);
    this.cookieJar = new tough.CookieJar();
    
    this.cookieJar.setCookieSync(`a=${aToken}`, 'https://www.furaffinity.net/');
    this.cookieJar.setCookieSync(`b=${bToken}`, 'https://www.furaffinity.net/');
    this.axiosInstance.defaults.baseURL = 'https://www.furaffinity.net/';
    this.axiosInstance.defaults.jar = this.cookieJar;
    this.axiosInstance.defaults.transformResponse = (data) => cheerio.load(data);
    this.axiosInstance.defaults.withCredentials = true;
  }
  
  async findLatestPost() {
    let response = await limiter.schedule(() => this.axiosInstance.get('/'));
    let htmlId = response.data('#gallery-frontpage-submissions figure').attr('id');
    if (!htmlId) throw new Error('Unknown homepage format');
    
    let id = /^sid-(.*)/.exec(htmlId)[1];
    this.latestId = id;
    return id;
  }

  async findPostByDate(targetDate, first) {
    let min = 1;
    let max = this.latestId;
    let mid = Math.floor(((max - min) / 2) + min);
    let notFounds = false;
    
    log.debug('Beginning binary search...');
    
    // Binary search to find approximate search range
    while (true) {
      log.debug(`Mid: ${mid}, Min: ${min}, Max: ${max}`);
      
      if (mid === min || mid === max) break;
      
      let response = await limiter.schedule(() => this.axiosInstance.get(`/view/${mid}`));
      
      // Post probably doesn't exist
      if (response.data('#page-submission').length === 0) {
        if (!notFounds) {
          mid = max - 1;
          notFounds = true;
        } else {
          mid--;
        }
        continue;
      } else {
        notFounds = false;
      }
      
      let rawDate = response.data('.stats-container .popup_date').attr('title');
      if (!rawDate) throw new Error("Unknown view page format");
      
      let date = this.convertDateStr(rawDate);
      if (!date) throw new Error("Unknown date format");


      log.debug(`Id: ${mid}, Parsed Date: ${date.toISOString()}, Target Date: ${targetDate.toISOString()}`)
      
      if (date > targetDate) {
        max = mid;
      } else if (date < targetDate) {
        min = mid;
      } else {
        break; // Found a post with the exact date
      }
      
      mid = Math.floor(((max - min) / 2) + min);
    }
    
    log.debug(`Beginning range walk - min: ${min}, max: ${max}`);
    
    // Walk up/down the range looking for the first/last post on the date
    if (first) {
      for (let i = min; i <= max; i++) {
        let response = await limiter.schedule(() => this.axiosInstance.get(`/view/${i}`));
        if (response.data('#page-submission').length === 0) continue; // Nothing at this id
        
        let rawDate = response.data('.stats-container .popup_date').attr('title');
        if (!rawDate) throw new Error("Unknown view page format");
        
        let date = this.convertDateStr(rawDate);
        if (!date) throw new Error("Unknown date format");
        
        log.debug(`Id: ${i}, Parsed Date: ${date.toISOString()}, Target Date: ${targetDate.toISOString()}`)
        
        if (date.getTime() == targetDate.getTime()) return i;
      }
    } else {
      for (let i = max; i >= min; i--) {
        let response = await limiter.schedule(() => this.axiosInstance.get(`/view/${i}`));
        if (response.data('#page-submission').length === 0) continue; // Nothing at this id
        
        let rawDate = response.data('.stats-container .popup_date').attr('title');
        if (!rawDate) throw new Error("Unknown view page format");
        
        let date = this.convertDateStr(rawDate);
        if (!date) throw new Error("Unknown date format");
        
        log.debug(`Id: ${i}, Parsed Date: ${date.toISOString()}, Target Date: ${targetDate.toISOString()}`)
        
        if (date.getTime() == targetDate.getTime()) return i;
      }
    }

    log.warn("Reached end of search without any matches. Check timestamp? (too specific)");
    return mid;
  }
  
  async fetchPostMeta(id) {
    let response;
    try {
      response = await limiter.schedule(() => this.axiosInstance.get(`/view/${id}`));
    } catch (err) {
      log.error('Request failed - rate limit might be reached! Sleeping for 10 seconds...');
      await (new Promise((resolve) => setTimeout(resolve, 10 * 1000)));
      return null;
    }

    if (response.data('#page-submission').length === 0) return null; // Nothing at this ID
    
    let isText = response.data('#text-container').length > 0;
    let isAudio = response.data('.audio-player-container').length > 0;
    let isImage = response.data('img#submissionImg').length > 0;
    let isFlash = response.data('#flash_embed').length > 0;
    
    let type;
    if (isText && isImage) {
      type = 'text';
    } else if (isAudio && isImage) {
       type = 'audio';
    } else if (isFlash) {
      type = 'flash';
    } else if (isImage) {
      type = 'image';
    } else {
      log.warn(`Id ${id}: No type filter matches - (UI update?)`);
    }
    
    let rating;
    if (response.data('img[src="/themes/classic/img/labels/general.gif"]').length === 1) {
      rating = 'general';
    } else if (response.data('img[src="/themes/classic/img/labels/mature.gif"]').length === 1) {
      rating = 'mature';
    } else if (response.data('img[src="/themes/classic/img/labels/adult.gif"]').length === 1) {
      rating = 'adult';
    } else {
      log.warn(`Id ${id}: No rating filter matches - (UI update?)`);
    }
    
    let title = response.data('.classic-submission-title.information h2').text();
    let author = response.data('.classic-submission-title.information a').text();
    let description = response.data('table.maintable table.maintable tr:nth-child(2) td').text().trim();
    let rawDate = response.data('.stats-container .popup_date').attr('title');
    let rawStats = response.data('.stats-container').text();
    let tags = response.data('#keywords a').map(function(i, e) {
      return response.data(this).text();
    }).get();
    
    let date = this.convertDateStr(rawDate);
    let stats = this.parseStatsContainer(rawStats);
    
    if (!title) log.warn(`Id ${id}: Title not found (UI update?)`);
    if (!author) log.warn(`Id ${id}: Author not found (UI update?)`);
    if (!description) log.warn(`Id ${id}: Description not found (UI update?)`);
    if (!rawDate) log.warn(`Id ${id}: Date not found (UI update?)`);
  
    let meta = {id, title, author, description, type, rating, tags, date, ...stats};
    return meta;
  }
  
  parseStatsContainer(rawText) {
    let stats = {};
    
    let keyValPairs = rawText.split(/\n/g);
    for (let i = 0; i < keyValPairs.length; i++) {
      let entry = keyValPairs[i].trim().split(': ');
      let key = entry[0];
      let value = entry[1];
      
      switch (key) {
        case 'Category': {
          stats.category = value;
          break;
        }
        
        case 'Theme': {
          stats.theme = value;
          break;
        }
        
        case 'Species': {
          stats.species = value;
          break;
        }
        
        case 'Gender': {
          stats.gender = value;
        }
      }
    }
    
    return stats;
  }
  
  convertMonthStr(value) {
    switch (value) {
      case 'Jan': return 0;
      case 'Feb': return 1;
      case 'Mar': return 2;
      case 'Apr': return 3;
      case 'May': return 4;
      case 'Jun': return 5;
      case 'Jul': return 6;
      case 'Aug': return 7;
      case 'Sep': return 8;
      case 'Oct': return 9;
      case 'Nov': return 10;
      case 'Dec': return 11;
    }
  }
  
  convertDateStr(value) {
    let partialDate = /([A-Z][a-z]*) (\d{1,2})(st|nd|rd|th), (\d{4}) (\d{1,2}):(\d{1,2}) (AM|PM)/.exec(value);
    if (!partialDate) return null;
    
    let month = this.convertMonthStr(partialDate[1]);
    let day = parseInt(partialDate[2]);
    let year = parseInt(partialDate[4]);
    let hour = parseInt(partialDate[5]) % 12;
    let minute = parseInt(partialDate[6]);
    let hour12 = partialDate[7];
    if (hour12 === 'PM') {
      hour += 12;
    }
    
    return new Date(Date.UTC(year, month, day, hour, minute));
  }
}
