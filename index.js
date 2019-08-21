'use strict'

// TODO: Show Deaths, logins, and disconnects, Discord <media> usage, Discord Nicknames.
// longterm TODO: refactor codebase completely.

const Discord = require('discord.js')
const Rcon = require('./lib/rcon.js')
const express = require('express')
const axios = require('axios')
const emojiStrip = require('emoji-strip')
const { Tail } = require('tail')
const fs = require('fs')

const configFile = (process.argv.length > 2) ? process.argv[2] : './config.json'
console.log('[INFO] Using configuration file:', configFile)


const c = require(configFile)
const debug = c.DEBUG
const shulker = new Discord.Client()
let app = null
let tail = null

// fixes the MC raw chat log by removing some weird characters in both username and text.
function fixMCText(text) {
  return text.replace(/(§[A-Z-a-z0-9])/g, '')
}


// replace mentions with discriminator with the actual mention
function replaceDiscordMentions(message) {
  if (c.ALLOW_USER_MENTIONS) {
    const possibleMentions = message.match(/@(\S+)/gim)
    if (possibleMentions) {
      for (let mention of possibleMentions) {
        const mentionParts = mention.split('#')
        let username = mentionParts[0].replace('@', '')
        if (mentionParts.length > 1) {
          const user = shulker.users.find(user => user.username === username && user.discriminator === mentionParts[1])
          if (user) {
            message = message.replace(mention, '<@' + user.id + '>')
          }
        }
      }
    }
  }
  return message
}



// Makes the actual message sent in discord channel.
function makeDiscordUserMessage(username, message) {
  // make a discord message string by formatting the configured template with the given parameters
  message = replaceDiscordMentions(message)

  return c.DISCORD_MESSAGE_TEMPLATE
    .replace('%username%', username)
    .replace('%message%', message)
}



// Creates the persona of the MC user in discord using its skin. 
function makeDiscordWebhook(username, message) {
  message = replaceDiscordMentions(message)

  return {
    username: username,
    content: message,
    'avatar_url': `https://minotar.net/helm/${username}/256.png`
  }
}

// creates the persona of the server telling important information. (Player achievement, connection, deaths, etc.)
function makeDiscordServerWebhook(message) {
  return {
    username: c.SERVER_NAME,
    content: message,
    'avatar_url': SERVER_AVATAR_URL
  }
}



// Creates the MC message to send in MC chat
function makeMinecraftTellraw(message) {
  // same as the discord side but with discord message parameters
  const username = emojiStrip(message.author.username)
  const discriminator = message.author.discriminator
  const text = emojiStrip(message.cleanContent)
  // hastily use JSON to encode the strings
  const variables = JSON.parse(JSON.stringify({ username, discriminator, text }))

  return c.MINECRAFT_TELLRAW_TEMPLATE
    .replace('%username%', variables.username)
    .replace('%discriminator%', variables.discriminator)
    .replace('%message%', variables.text)
}



function initApp() {
  // run a server if not local
  if (!c.IS_LOCAL_FILE) {
    app = express()
    const http = require('http').Server(app)

    app.use(function (request, response, next) {
      request.rawBody = ''
      request.setEncoding('utf8')

      request.on('data', function (chunk) {
        request.rawBody += chunk
      })

      request.on('end', function () {
        next()
      })
    })

    const serverport = process.env.PORT || c.PORT

    http.listen(serverport, function () {
      console.log('[INFO] Bot listening on *:' + serverport)
    })
  } else {
    if (fs.existsSync(c.LOCAL_FILE_PATH)) {
      console.log('[INFO] Using configuration for local file at "' + c.LOCAL_FILE_PATH + '"')
      tail = new Tail(c.LOCAL_FILE_PATH)
    } else {
      throw new Error('[ERROR] Local file not found at "' + c.LOCAL_FILE_PATH + '"')
    }
  }
}



function watch(callback) {
  if (c.IS_LOCAL_FILE) {
    tail.on('line', function (data) {
      // ensure that this is a message
      if (data.indexOf(': <') !== -1) {
        callback(data)
      }
    })
  } else {
    app.post(c.WEBHOOK, function (request, response) {
      callback(request.rawBody)
      response.send('')
    })
  }
}



// message from MC.
shulker.on('ready', function () {
  watch(function (body) {
    console.log('[INFO] Recieved ' + body)
    const userRe = new RegExp(c.REGEX_MATCH_USER_CHAT_MC)
    const joinRe = new RegExp(c.REGEX_PLAYER_JOIN)
    const leaveRe = new RegExp(c.REGEX_PLAYER_LEAVE)


    // if an MC user sends message. 
    if (userRe.test(body)) {
      const bodymatch = body.match(userRe)
      const username = fixMCText(bodymatch[1])
      const message = fixMCText(bodymatch[2])

      if (debug) {
        console.log('[DEBUG] Username: ' + username)
        console.log('[DEBUG] Text: ' + message)
      }
      if (c.USE_WEBHOOKS) {
        const webhook = makeDiscordWebhook(username, message)
        axios.post(c.WEBHOOK_URL, {
          ...webhook
        }, {
            headers: {
              'Content-Type': 'application/json'
            }
          })
      } else {
        // find the channel
        const channel = shulker.channels.find((ch) => ch.id === c.DISCORD_CHANNEL_ID && ch.type === 'text')
        channel.send(makeDiscordUserMessage(username, message))
      }
    }

    // player joins
    else if (joinRe.test(body)) {
      const username = fixMCText(bodymatch[1])

      if (debug) {
        console.log('[Debug]:c' + username + ' has connected to the server')
      }
      const webhook = makeDiscordServerWebhook(username + " has joined the server!")
      axios.post(c.WEBHOOK_URL, {
        ...webhook
      }, {
          headers: {
            'Content-Type': 'application/json'
          }
        })
    } // end player joins

    // player leaves
    else if (leaveRe.test(body)) {
      const username = fixMCText(bodymatch[1])

      if (debug) {
        console.log('[Debug]:c' + username + ' has left the server')
      }
      const webhook = makeDiscordServerWebhook(username + " has left the server. =(")
      axios.post(c.WEBHOOK_URL, {
        ...webhook
      }, {
          headers: {
            'Content-Type': 'application/json'
          }
        })
    } // end player leaves



  })
})

// Message from Discord.
shulker.on('message', function (message) {
  if (message.channel.id === c.DISCORD_CHANNEL_ID && message.channel.type === 'text') {
    if (c.USE_WEBHOOKS && message.webhookID) {
      return // ignore webhooks if using a webhook
    }
    if (message.author.id !== shulker.user.id) {
      if (message.attachments.length) {
        // skip images/attachments
        // TODO: make "<media attached>" formatted
        message = message + "<media attached>"
        return
      }
      const client = new Rcon(c.MINECRAFT_SERVER_RCON_IP, c.MINECRAFT_SERVER_RCON_PORT) // create rcon client
      client.auth(c.MINECRAFT_SERVER_RCON_PASSWORD, function () { // only authenticate when needed
        client.command('tellraw @a ' + makeMinecraftTellraw(message), function (err) {
          if (err) {
            console.log('[ERROR]', err)
          }
          client.close() // close the rcon connection
        })
      })
    }
  }
})




// initialization.
initApp()
shulker.login(c.DISCORD_TOKEN)
