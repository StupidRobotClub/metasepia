/*
**  Requires
*/

const Irc = require('irc')
const Pino = require('pino')
const config = require('config')
const knex = require('knex')
const moment = require('moment-timezone')
const Chance = require('chance')

/*
**  Config
*/

const pinoConfig = config.get('pinoConfig')
const ircConfig = config.get('irc')
const dbConfig = config.get('dbConfig')
const {
  streamerAliases,
  topicTrackingChannels,
  silentChannels,
  commandPrefix,
  longbowAdvice,
} = config.get('meta')

/*
**  Initialization
*/

const log = Pino(pinoConfig)
const client = new Irc.Client(ircConfig.server, ircConfig.name, ircConfig.config)
const db = knex(dbConfig)
moment.tz.setDefault('Etc/GMT')
const chance = new Chance()

// Killswitch for when things get hung up, ctrl+c twice to hit it
let forceKill = false

/*
**  Functions
*/

const leftPad = (str, amount = 2) => {
  str += ''
  const out = [...str]
  while (out.length < amount) {
    out.unshift(0)
  }
  return out.join('')
}

const escapeRegex = str => str.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

const hasNotNull = (obj, prop) => {
  return obj && typeof obj === 'object' && obj.hasOwnProperty(prop) && obj[prop]
}

const mangleNick = nick => nick
  .split('')
  .map(x => {
    switch (x) {
      case 'a': return '\u00E0'
      case 'c': return '\u00E7'
      case 'e': return '\u00E8'
      case 'i': return '\u00EC'
      case 'n': return '\u00F1'
      case 'o': return '\u00F2'
      case 'u': return '\u00F9'
      case 'y': return '\u00FD'
      case 'A': return '\u00C0'
      case 'C': return '\u00C7'
      case 'D': return '\u00D0'
      case 'E': return '\u00C8'
      case 'I': return '\u00CC'
      case 'N': return '\u00D1'
      case 'O': return '\u00D2'
      case 'U': return '\u00D9'
      case 'Y': return '\u00DD'
      default: return x
    }
  })
  .join('')

const findAndMangleNicks = str => {
  const aliases = streamerAliases
    .reduce((p, c) => p.concat(c), [])
    .map(x => escapeRegex(x))
    .join('|')
  const search = new RegExp(`\\b(?:${aliases})\\b`, 'gi')
  let res = search.exec(str)
  const matches = []
  while (res) {
    matches.push(res[0])
    res = search.exec(str)
  }
  matches.forEach(nick => {
    str = str.replace(nick, mangleNick(nick))
  })
  return str
}

const parseTopic = (channel, topic, nick, message) => {
  // Short circuit if we get a topic message from a channel we don't care about
  if (!topicTrackingChannels.some(x => x === channel)) return null
  // Short circuit if we get a topic message from a source OTHER than a user
  if (message.command !== 'TOPIC') return null

  log.info('Topic Change Detected:', topic)

  const streamers = getStreamers(topic)
  const activityType = getActivityType(topic)
  const activity = getActivity(activityType, topic)

  if (streamers && activity)
    startSession(streamers, activityType, activity, topic)
  else
    endSession()
}

const startSession = (streamers, activityType, activity, topicString) => {
  log.debug({
    session: {
      streamers,
      activityType,
      activity,
      topicString,
    }
  }, 'Starting session')
  // Don't worry about calling endSession first
  // newSession will automatically close any previous sessions
  db.raw('call newSession(?, ?, ?, ?)', [streamers, activity, topicString, activityType])
    .then(res => {
      const sessionId = res[0][0].session_id
      log.debug({ sessionId }, 'Session successfully started')
    })
    .catch(err => {
      log.error(err)
    })
}

const endSession = () => {
  log.debug('Ending session')
  db.raw('call endSession()')
    .then(res => log.debug({ results: res }, 'Session successfully ended'))
    .catch(err => log.error(err))
}

const getStreamers = str => {
  log.debug('Getting Streamers...')
  const streamers = /streamers?:(?:\s*)(.*?)(?:\s*)\|/i.exec(str)
  log.debug({ streamers }, 'STREAMERS RESULT')
  return streamers[1].toLowerCase()
}

const getActivityType = str => {
  log.debug('Getting Activity Type...')
  const activityType = /\|(?:\s*)(\S+)(?:\s*):/.exec(str)
  log.debug({ activityType }, 'ACTIVITY TYPE RESULT')
  return activityType[1].toLowerCase()
}

const getActivity = (type, str) => {
  log.debug('Getting Activity...')
  const activity = (new RegExp(`${type}:(?:\\s*)(.*?)(?:\\s*)(?:\\||$)`, 'i')).exec(str)
  log.debug({ activity }, 'ACTIVITY RESULT')
  return activity[1].toLowerCase()
}

const parseMessage = (from, to, message) => {
  log.debug(from, to, message)
  const parsedCommand = (new RegExp(`^${commandPrefix}(\\S*)`)).exec(message)
  let command = parsedCommand ? parsedCommand[1] : ''
  if ((to[0] === '#' || to === ircConfig.name) && command) {
    if (to === ircConfig.name) to = from

    const opts = {
      leet: /leet/i.test(command),
      yell: command.replace(/[a-z]/g, '') === command,
      notice: false,
    }
    command = command
      .replace(/leet/i, '')
      .toLowerCase()

    if (commands.hasOwnProperty(command)) {
      log.debug({ command }, `Command parsed: ${command}`)
      commands[command](from, to, message, opts)
    } else
      log.debug({ command }, `Unrecognized Command given: ${command}`)
  }
}

const linkDiscord = (from, to, message, opts) => {
  delete opts.leet
  send(to, `${from}: https://discord.gg/R7cazz8`, opts)
}

const linkOnDemand = (from, to, message, opts) => {
  delete opts.leet
  send(to, `${from}: http://vacker.tv/ondemand/`, opts)
}

const linkWebDB = (from, to, message, opts) => {
  delete opts.leet
  send(to, `${from}: https://played.vacker.tv/`, opts)
}

const linkYT = (from, to, message, opts) => {
  delete opts.leet
  send(to, `${from}: https://www.youtube.com/user/Dopelives`, opts)
}

const larryHelp = (from, to, message, opts) => {
  const advice = chance.pickone(longbowAdvice)
  send(to, `Larry would probably say: \u001D${findAndMangleNicks(advice)}`, opts)
}

const parseOptions = str => {
  // g: activity
  // t: type
  // s: streamer
  // e: exclusion (from activity)
  const g = /g:(?:\s*)([\w\d\s&%$#@!*()_,+=[\]{}'"./\\-]*?)(?:[\W]*)(?:(?:[gtse]:)|$)/i.exec(str)
  const t = /t:(?:\s*)([\w\d\s-]*?)(?:[\W]*)(?:(?:[gtse]:)|$)/i.exec(str)
  const s = /s:(?:\s*)([\w\d\s-]*?)(?:[\W]*)(?:(?:[gtse]:)|$)/i.exec(str)
  const e = /e:(?:\s*)([\w\d\s&%$#@!*()_,+=[\]{}'"./\\-]*?)(?:[\W]*)(?:(?:[gtse]:)|$)/i.exec(str)
  const i = /(?:(?:p(?:layed)?)|(?:l(?:.*?(?:ast)|(?:played))?))(?:\s*)-(\d+)/.exec(str)
  const res = {
    g: g ? g[1] : null,
    t: t ? t[1] : null,
    s: s ? s[1] : null,
    e: e ? e[1].split(/(?:\s*)(?:([\w\d\s&%$#@!*()_-]*),?)/).filter(x => x !== '') : null,
    i: i ? i[1] : null,
  }
  log.debug(res, 'OPTIONS RESULTS')
  return res
}

const playedConstructor = options => {
  const query = db.select()
    .from('sessions_view')
    .where(builder => {
      if (options.g) builder.andWhere('activity', 'LIKE', `%${options.g}%`)
      if (options.e) builder.andWhere(builder => {
        options.e.forEach(exclusion => {
          builder.andWhere('activity', 'NOT LIKE', `%${exclusion}%`)
        })
      })
      if (options.t) builder.andWhere('activity_type', 'LIKE', `%${options.t}%`)
      if (options.s) builder.andWhere(builder => {
        const aliases = streamerAliases.find(x => x.some(y => y.toLowerCase() === options.s))
        if (aliases) aliases.forEach(alias => builder.orWhere('streamer', 'RLIKE', `[[:<:]]${alias}[[:>:]]`))
        else builder.andWhere('streamer', 'RLIKE', `[[:<:]]${options.s}[[:>:]]`)
      })
    })
  log.debug({ query: query.toString() }, 'CONSTRUCTED QUERY')

  return query
}

const parseTimeHours = duration => {
  return `${leftPad(duration.get('hours'))}h ${leftPad(duration.get('minutes'))}m ${leftPad(duration.get('seconds'))}s`
}

const lastPlayed = (from, to, message, opts) => {
  const options = parseOptions(message)

  playedConstructor(options)
    .limit(options.i + 1 || 1)
    .whereNotNull('end_timestamp')
    .then(res => {
      if (!res.length) {
        send(to, `I didn't find any results for "${message}"`)
        return null
      }
      res = res[Math.min(options.i, res.length - 1) || 0]
      const duration = moment.duration(res.duration_in_seconds, 'seconds')
      const preOutput = `${res.streamer} streamed the ${res.activity_type} ${res.activity} for ${parseTimeHours(duration)}, about ${moment(res.end_timestamp).fromNow()}`
      const output = `${from}: ${findAndMangleNicks(preOutput)}`
      send(to, output, opts)
    })
    .catch(err => log.error(err))
}

const firstPlayed = (from, to, message, opts) => {
  const options = parseOptions(message)

  playedConstructor(options)
    .limit(1)
    .whereNotNull('end_timestamp')
    .orderBy('session_id', 'ASC')
    .then(res => {
      if (!res.length) {
        send(to, `I didn't find any results for "${message}"`, opts)
        return null
      }
      res = res[0]
      const duration = moment.duration(res.duration_in_seconds, 'seconds')
      const preOutput = `${res.streamer} first streamed the ${res.activity_type} ${res.activity} for ${parseTimeHours(duration)}, about ${moment(res.end_timestamp).fromNow()}`
      const output = `${from}: ${findAndMangleNicks(preOutput)}`
      send(to, output, opts)
    })
    .catch(err => log.error(err))
  return null
}

const totalPlayed = (from, to, message, opts) => {
  const options = parseOptions(message)
  const searchQuery = playedConstructor(options)

  db
    .raw('SET SQL_MODE=\'ALLOW_INVALID_DATES\'')
    .then(() => db.raw('drop temporary table if exists totalgames'))
    .then(() => db.raw(searchQuery.toString()).wrap('create temporary table totalgames(primary key(session_id))'))
    .then(() => db.raw('select start_timestamp into @st from totalgames order by session_id asc limit 1'))
    .then(() => db.raw('select end_timestamp into @en from totalgames order by session_id desc limit 1'))
    .then(() => db.raw('select streamer into @str from totalgames order by session_id desc limit 1'))
    .then(() => db.raw('select sum(duration_in_seconds) into @dur from totalgames'))
    .then(() => db.raw('select @st as start_timestamp, @en as end_timestamp, @str as streamer, @dur as duration_in_seconds'))
    .then(res => {
      res = res[0][0]
      const totalDuration = moment.duration(res.duration_in_seconds, 'seconds')
      const durationDays = Math.floor(totalDuration.asDays())
      totalDuration.subtract(durationDays, 'days')
      const durationHours = Math.floor(totalDuration.asHours())
      totalDuration.subtract(durationHours, 'hours')
      const durationMinutes = Math.floor(totalDuration.asMinutes())
      totalDuration.subtract(durationMinutes, 'minutes')
      const durationSeconds = Math.floor(totalDuration.asSeconds())
      const durationText = [durationDays, durationHours, durationMinutes, durationSeconds].reduce((p, c, i) => {
        if (i === 0 && c > 0) p += `${c} days `
        else if (i === 1 && (c > 0 || p.length > 0)) p += `${c} hours `
        else if (i === 2) p += `${c} minutes and `
        else if (i === 3) p += `${c} seconds `
        return p
      }, '')
      const preOutput = `${options.g} was last streamed by ${res.streamer} on ${moment(res.end_timestamp)}, was first streamed on ${moment(res.start_timestamp)}, and has been streamed for a total of ${durationText}.`
      const output = `${from}: ${findAndMangleNicks(preOutput)}`
      send(to, output, opts)
    })
    .catch(err => log.error(err))

  return null
}

const currentlyPlaying = (from, to, message, opts) => {
  db.select()
    .from('sessions_view')
    .limit(1)
    .then(res => {
      if (!res.length) {
        send(to, `Sorry ${from}, it looks to me like nobody's ever streamed.`, opts)
        return null
      }

      res = res[0]

      const duration = moment.duration(moment().diff(moment(res.start_timestamp), 'milliseconds'), 'milliseconds')
      const response = (res.end_timestamp) ? 'Nobody is currently streaming.' : `${res.streamer} has been streaming the ${res.activity_type} ${res.activity} for ${parseTimeHours(duration)}`
      const output = `${from}: ${findAndMangleNicks(response)}`
      send(to, output, opts)
    })
    .catch(err => log.error(err))
}

const playedToday = (from, to, message, opts) => {
  db.select()
    .from('sessions_view')
    .where('start_timestamp', '>', moment().subtract('24', 'hours').format('Y-MM-DD kk:mm:ss'))
    .then(res => {
      if (!res.length) {
        send(to, `Sorry ${from}, it looks like nobody's streamed in the last 24 hours.`, opts)
        return null
      }
      const streamers = res.map(x => x.streamer).join(', ')
      const duration = moment.duration(res.reduce((p, c) => p += c.duration_in_seconds, 0), 'seconds')
      const preOutput = `found ${res.length} streams (${streamers}), totalling ${parseTimeHours(duration)}.`
      const output = `${from}: ${findAndMangleNicks(preOutput)}`
      send(to, output, opts)
    })
    .catch(err => log.error(err))
}

const leet = str => str
  .replace(/a/ig, '4')
  .replace(/b/g, '6')
  .replace(/e/ig, '3')
  .replace(/g/g, '9')
  .replace(/[iIl]/g, '1')
  .replace(/o/ig, '0')
  .replace(/s/ig, '5')
  .replace(/t/ig, '7')
  .replace(/z/ig, '2')

// For legacy commands
const leetCommand = func => (from, to, message) => func(from, to, message, { leet: true })

const yell = str => str.toUpperCase()

const send = (to, message, opts) => {
  // Valid options:
  // {
  //   notice: false,
  //   leet: false,
  //   yell: false,
  // }
  if (hasNotNull(opts, 'notice')) return client.notice(to, message)
  if (silentChannels.some(channel => channel === to)) return null

  // Fun things!
  if (hasNotNull(opts, 'leet')) message = leet(message)
  if (hasNotNull(opts, 'yell')) message = yell(message)

  client.say(to, message)
}

const shutdown = (code = 0, reason = '') => {
  if (forceKill) {
    log.error('!!! FORCING SHUTDOWN !!!')
    client.conn.destroy()
    process.exit(1)
  }
  log.warn({ reason }, 'Shutting Down')
  client.disconnect((code === 0) ? 'Shutting Down' : 'Error', () => process.exit(code))
  forceKill = true
}

// Command mapping
const commands = {
  'l': lastPlayed,
  'last': lastPlayed,
  'lastplayed': lastPlayed,
  'p': lastPlayed,
  'played': lastPlayed,
  'f': firstPlayed,
  'first': firstPlayed,
  'firstplayed': firstPlayed,
  't': totalPlayed,
  'total': totalPlayed,
  'totalplayed': totalPlayed,
  'c': currentlyPlaying,
  'current': currentlyPlaying,
  'currentlyplaying': currentlyPlaying,
  'disco': linkDiscord,
  'discord': linkDiscord,
  'ondemand': linkOnDemand,
  'vod': linkOnDemand,
  'db': linkWebDB,
  'web': linkWebDB,
  'playedweb': linkWebDB,
  'yt': linkYT,
  'youtube': linkYT,
  'today': playedToday,
  'playedtoday': playedToday,

  // Larry
  'larry': larryHelp,
  'larrylongbow': larryHelp,
  'longbow': larryHelp,
  'wwld': larryHelp,

  // LEGACY
  'f1r57p14y3d': leetCommand(firstPlayed),
  'pl4y3d': leetCommand(lastPlayed),
  'p14y3d': leetCommand(lastPlayed),
  'l457p14y3d': leetCommand(lastPlayed),
  '1457p14y3d': leetCommand(lastPlayed),
  'played24h': playedToday,
  'todayplayed': playedToday,
  // 'r4nd0mp14y3d': leetCommand(randomPlayed),
  // 'notrealplayed': fakePlayed,
  // 'prayed': fakePlayed,
  // 'piayed': fakePlayed,
  // 'playedruse': fakePlayed,

  // Unemplemented
  // 'nextplayed': nextPlayed,
  // 'randomplayed': randomPlayed,
  // 'fake': fakePlayed,
  // 'p1ayed': fakePlayed,
  // 'playedfake': fakePlayed,
  //  Nobody
  // 'nobody': nobodyPlayed,
  // 'nobodyplayed': nobodyPlayed,

  // WISDOM opt
  // "flying and shooting lasers and shit"
  // Not actually sure what this one does?
  // But add it as a modifier with the same setup as leet
  // my $com_lastplayedwisdomleet = "!p14y3dw15d0m";
  // my $com_lastplayedwisdom = "!lastplayedwisdom";
  // my $com_lastplayedwisdom2 = "!playedwisdom";
}

/*
**  Event Listeners
*/

client.addListener('message', parseMessage)
client.addListener('topic', parseTopic)
client.addListener('registered', () => log.info('Client connected...'))
client.addListener('error', err => shutdown(1, err))
process.on('SIGINT', () => shutdown())
process.on('uncaughtException', err => shutdown(1, err))

/*
**  Run
*/

log.info('Connecting...')
db.raw('call countUnmappedActivities()')
  .then(res => {
    log.warn(res[0][0][0])
    client.connect()
  })
  .catch(err => {
    log.error(err)
    shutdown(1, err)
  })
