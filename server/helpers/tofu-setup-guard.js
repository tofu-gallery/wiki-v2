// Tofu (2026-10-27): this file is Tofu's addition; it is not part of upstream Wiki.js.

const net = require('net')

// The setup's count of wrong ADMIN_PASSWORDs (server/setup.js), kept for each client address, in memory: ten wrong
// passwords in a row from one address close the setup for that address for 15 minutes, and the owner's password from
// it forgets its count. An IPv6 address shares its count with the rest of its /64 (addressKey), and no address outside
// a count is refused because of it: a stranger's guesses from another network cannot keep the owner out, but someone
// who shares the owner's public IPv4 address (the same home or office network, or a provider's shared address) or IPv6
// /64 can, 15 minutes at a time.
const WRONG_IN_A_ROW = 10
const CLOSED_FOR = 15 * 60 * 1000
// At most this many addresses are kept; past it, the one counted longest ago is forgotten. So the count stops one
// guesser, not a crowd: someone guessing from more addresses than this in turn (or more IPv6 /64s, of which one /48
// holds 65,536) has each of them forgotten before its tenth wrong password, and none of them is ever closed.
const MAX_ADDRESSES = 1000

/**
 * The eight 16-bit groups of an IPv6 address that net.isIPv6 accepts, without its zone (`%eth0`).
 */
function ipv6Groups (address) {
  let text = address.split('%')[0].toLowerCase()
  const ipv4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4) {
    const bytes = ipv4.slice(1).map(Number)
    text = `${text.slice(0, ipv4.index)}${((bytes[0] << 8) + bytes[1]).toString(16)}:${((bytes[2] << 8) + bytes[3]).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const front = head ? head.split(':') : []
  const back = tail ? tail.split(':') : []
  const zeros = tail === undefined ? [] : new Array(8 - front.length - back.length).fill('0')
  return front.concat(zeros, back).map(group => parseInt(group, 16))
}

/**
 * What an address is counted as: an IPv4 address as itself, also when it is written as IPv6 (`::ffff:a.b.c.d`), and an
 * IPv6 address as its /64, the network one client is usually given, so that one /64 cannot make itself new addresses
 * (a larger network, such as a /56 or a /48, holds many /64s, each counted on its own). Null for anything that is not
 * an IP address.
 */
function addressKey (text) {
  const address = String(text || '').trim()
  if (net.isIPv4(address)) {
    return address
  }
  if (!net.isIPv6(address)) {
    return null
  }
  const groups = ipv6Groups(address)
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.')
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`
}

/**
 * The address a setup request came from. The setup's Express app trusts no proxy, so its req.ip is the nearest proxy's.
 * On Tofu every request reaches the app from a local proxy (127.0.0.1), and the hosting writes X-Forwarded-For itself,
 * with the client's own address as its only entry, whatever the client sent in it (measured on 2026-10-27). So the
 * address is the last entry of X-Forwarded-For, the one the nearest proxy wrote, when it is an IP address; else the
 * connection's own address (on Tofu the local proxy's, which every such request would share); else 'unknown', one
 * count for every request with neither.
 */
function clientAddress (req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop()
  return addressKey(forwarded) || addressKey(req.socket && req.socket.remoteAddress) || 'unknown'
}

/**
 * A new, empty count. `closed(address)` says whether the setup is closed for that address now, `wrong(address)` counts
 * a wrong password from it, and `right(address)` forgets it, after the owner's password.
 */
function createGuard () {
  // address: { wrong, closedUntil }, in the order they were last counted, oldest first.
  const addresses = new Map()
  return {
    closed (address) {
      const entry = addresses.get(address)
      return Boolean(entry) && Date.now() < entry.closedUntil
    },
    wrong (address) {
      const now = Date.now()
      // A closure that is over leaves nothing to keep: its count started again at 0 when it closed.
      for (const [key, entry] of addresses) {
        if (entry.closedUntil && entry.closedUntil <= now) {
          addresses.delete(key)
        }
      }
      const entry = addresses.get(address) || { wrong: 0, closedUntil: 0 }
      addresses.delete(address)
      entry.wrong++
      if (entry.wrong >= WRONG_IN_A_ROW) {
        entry.wrong = 0
        entry.closedUntil = now + CLOSED_FOR
      }
      addresses.set(address, entry)
      if (addresses.size > MAX_ADDRESSES) {
        addresses.delete(addresses.keys().next().value)
      }
    },
    right (address) {
      addresses.delete(address)
    },
    get size () {
      return addresses.size
    }
  }
}

module.exports = { addressKey, clientAddress, createGuard }
