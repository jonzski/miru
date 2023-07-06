import { mapBestRelease } from '../anime.js'
import { fastPrettyBytes } from '../util.js'
import { exclusions } from '../rss.js'
import { set } from '@/views/Settings.svelte'
import { alRequest } from '../anilist.js'

const toshoURL = decodeURIComponent(atob('aHR0cHM6Ly9mZWVkLmFuaW1ldG9zaG8ub3JnL2pzb24/'))

export default async function tosho ({ media, episode }) {
  const json = await getAniDBFromAL(media)

  if (!json) return []

  const aniDBEpisode = await getAniDBEpisodeFromAL({ media, episode }, json)

  let entries = await getToshoEntries(media, aniDBEpisode, json, set.rssQuality)

  if (!entries.length) entries = await getToshoEntries(media, aniDBEpisode, json)

  return mapBestRelease(mapTosho2dDeDupedEntry(entries))
}

window.tosho = tosho

async function getAniDBFromAL (media) {
  console.log('getting AniDB ID from AL')
  const mappingsResponse = await fetch('https://api.ani.zip/mappings?anilist_id=' + media.id)
  const json = await mappingsResponse.json()
  if (json.mappings.anidb_id) return json

  console.log('failed getting AniDB ID, checking via parent')

  const parentID = getParentForSpecial(media)

  if (!parentID) return

  console.log('found via parent')

  const parentResponse = await fetch('https://api.ani.zip/mappings?anilist_id=' + parentID)
  return parentResponse.json()
}

function getParentForSpecial (media) {
  if (!['SPECIAL', 'OVA', 'ONA'].some(format => media.format === format)) return false
  const animeRelations = media.relations.edges.filter(({ node }) => node.type === 'ANIME')

  return getRelation(animeRelations, 'PARENT') || getRelation(animeRelations, 'PREQUEL') || getRelation(animeRelations, 'SEQUEL')
}

function getRelation (list, type) {
  return list.find(({ relationType }) => relationType === type)?.node.id
}

// TODO: https://anilist.co/anime/13055/
async function getAniDBEpisodeFromAL ({ media, episode }, { episodes, episodeCount }) {
  console.log('getting AniDB EpID for Mal EP', { episode, episodes })
  if (!episode || !Object.values(episodes).length) return
  if (media.episodes && media.episodes === episodeCount && episodes[Number(episode)]) return episodes[Number(episode)]
  console.log('EP count doesn\'t match, checking by air date')
  const res = await alRequest({ method: 'EpisodeDate', id: media.id, ep: episode })
  const alDate = new Date((res.data.AiringSchedule?.airingAt || 0) * 1000)

  if (!+alDate) return episodes[Number(episode)] || episodes[1] // what the fuck, are you braindead anilist?, the source episode number to play is from an array created from AL ep count, so how come it's missing?

  // find closest episode by air date
  // ineffcient but reliable
  return Object.values(episodes).reduce((prev, curr) => {
    return Math.abs(new Date(curr.airdate) - alDate) < Math.abs(new Date(prev.airdate) - alDate) ? curr : prev
  })
}

async function getToshoEntries (media, episode, { mappings }, quality) {
  const promises = []

  if (episode) {
    const { anidbEid } = episode

    console.log('fetching episode', anidbEid, quality)

    promises.push(fetchSingleEpisode({ id: anidbEid, quality }))
  } else {
    // TODO: look for episodes via.... title?
  }

  // look for batches and movies
  const movie = isMovie(media)
  if (mappings.anidb_id && media.status === 'FINISHED' && (movie || media.episodes !== 1)) {
    promises.push(fetchBatches({ episodeCount: media.episodes, id: mappings.anidb_id, quality }))
    console.log('fetching batch', quality, movie)
    if (!movie) {
      const courRelation = getSplitCourRelation(media)
      if (courRelation) {
        console.log('found split cour!')
        const episodeCount = (media.episodes || 0) + (courRelation.episodes || 0)
        const mappingsResponse = await fetch('https://api.ani.zip/mappings?anilist_id=' + courRelation.id)
        const json = await mappingsResponse.json()
        console.log('found mappings for split cour', !!json.mappings.anidb_id)
        if (json.mappings.anidb_id) promises.push(fetchBatches({ episodeCount, id: json.mappings.anidb_id, quality }))
      }
    }
  }

  return (await Promise.all(promises)).flat()
}

function getSplitCourRelation (media) {
  // Part 2 / Cour 3 / 4th Cour
  if (isTitleSplitCour(media)) return getCourPrequel(media)

  // Part 1 of split cour which usually doesn't get labeled as split cour
  // sequel can not exist
  return getCourSequel(media)
}

const courRegex = /[2-9](?:nd|rd|th) Cour|Cour [2-9]|Part [2-9]/i

function isTitleSplitCour (media) {
  const titles = [...Object.values(media.title), ...media.synonyms]

  console.log('checking cour titles', titles)

  return titles.some(title => courRegex.test(title))
}

const seasons = ['WINTER', 'SPRING', 'SUMMER', 'FALL']
const getDate = ({ seasonYear, season }) => new Date(`${seasonYear}-${seasons.indexOf(season) * 4 || 1}-01`)

function getMediaDate (media) {
  if (media.startDate) return new Date(Object.values(media.startDate).join(' '))
  return getDate(media)
}

function getCourSequel (media) {
  const mediaDate = getMediaDate(media)
  const animeRelations = media.relations.edges.filter(({ node, relationType }) => {
    if (node.type !== 'ANIME') return false
    if (node.status !== 'FINISHED') return false
    if (relationType !== 'SEQUEL') return false
    if (!['OVA', 'TV'].some(format => node.format === format)) return false // not movies or ona's
    if (mediaDate > getMediaDate(node)) return false // node needs to be released after media to be a sequel
    return isTitleSplitCour(node)
  })

  if (!animeRelations.length) return false

  // get closest sequel
  return animeRelations.reduce((prev, curr) => {
    return getMediaDate(prev) - mediaDate > getMediaDate(curr) - mediaDate ? curr : prev
  })
}

function getCourPrequel (media) {
  const mediaDate = getMediaDate(media)
  const animeRelations = media.relations.edges.filter(({ node, relationType }) => {
    if (node.type !== 'ANIME') return false
    if (node.status !== 'FINISHED') return false
    if (relationType !== 'PREQUEL') return false
    if (!['OVA', 'TV'].some(format => node.format === format)) return false
    if (mediaDate < getMediaDate(node)) return false // node needs to be released before media to be a prequel
    return true
  }).map(({ node }) => node)

  if (!animeRelations.length) {
    console.error('Detected split count but couldn\'t find prequel', media)
    return false
  }

  // get closest prequel
  return animeRelations.reduce((prev, curr) => {
    return mediaDate - getMediaDate(prev) > mediaDate - getMediaDate(curr) ? curr : prev
  })
}

function isMovie (media) {
  if (media.format === 'MOVIE') return true
  if ([...Object.values(media.title), ...media.synonyms].some(title => title.toLowerCase().includes('movie'))) return true
  // if (!getParentForSpecial(media)) return true // TODO: this is good for checking movies, but false positives with normal TV shows
  return media.duration > 80 && media.episodes === 1
}

function buildQuery (quality) {
  let query = `&qx=1&q=!("${exclusions.join('"|"')}")`
  if (quality) query += ` "'${quality}"`

  return query
}

async function fetchBatches ({ episodeCount, id, quality }) {
  const queryString = buildQuery(quality)
  const torrents = await fetch(toshoURL + 'order=size-d&aid=' + id + queryString)

  // safe if AL includes EP 0 or doesn't
  const batches = (await torrents.json()).filter(entry => entry.num_files >= episodeCount)
  console.log({ batches })
  return batches
}

async function fetchSingleEpisode ({ id, quality }) {
  const queryString = buildQuery(quality)
  const torrents = await fetch(toshoURL + 'eid=' + id + queryString)

  const episodes = await torrents.json()
  console.log({ episodes })
  return episodes
}

function mapTosho2dDeDupedEntry (entries) {
  const deduped = {}
  for (const entry of entries) {
    if (deduped[entry.info_hash]) {
      const dupe = deduped[entry.info_hash]
      dupe.title ??= entry.title || entry.torrent_name
      dupe.id ||= entry.nyaa_id
      dupe.seeders ||= entry.seeders >= 100000 ? entry.leechers * 3 : entry.seeders
      dupe.leechers ||= entry.leechers ?? 0
      dupe.downloads ||= entry.torrent_downloaded_count
      dupe.size ||= entry.total_size && fastPrettyBytes(entry.total_size)
      dupe.date ||= entry.timestamp && new Date(entry.timestamp * 1000)
    } else {
      deduped[entry.info_hash] = {
        title: entry.title || entry.torrent_name,
        link: entry.magnet_uri,
        id: entry.nyaa_id,
        seeders: entry.seeders >= 100000 ? entry.leechers * 3 : entry.seeders, // this is a REALLY bad assumption to make, but its a decent guess
        leechers: entry.leechers,
        downloads: entry.torrent_downloaded_count,
        size: entry.total_size && fastPrettyBytes(entry.total_size),
        date: entry.timestamp && new Date(entry.timestamp * 1000)
      }
    }
  }

  return Object.values(deduped)
}