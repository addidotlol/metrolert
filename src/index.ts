import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { parse as CSVParse } from '@std/csv/parse';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { Rettiwt } from 'rettiwt-api';
import { Bot } from '@skyware/bot';

export default {
	async fetch(req) {
		const url = new URL(req.url);
		url.pathname = '/__scheduled';
		url.searchParams.append('cron', '* * * * *');
		return new Response(`To test the scheduled handler, ensure you have used the "--test-scheduled" then try running "curl ${url.href}".`);
	},

	// The scheduled handler is invoked at the interval set in our wrangler.jsonc's
	// [[triggers]] configuration.
	async scheduled(event, env, ctx): Promise<void> {
		const gtfsSchedule = await fetch('https://metrolinktrains.com/globalassets/about/gtfs/gtfs.zip');
		const scheduleBlob = await gtfsSchedule.blob();

		const blobReader = new BlobReader(scheduleBlob);
		const zipReader = new ZipReader(blobReader);
		const zipEntries = await zipReader.getEntries();

		const tripsEntry = zipEntries.find((entry) => entry.filename === 'trips.txt');
		if (!tripsEntry || !tripsEntry.getData) {
			console.error('trips.txt not found');
			return;
		}
		const tripsWriter = new TextWriter();
		const tripsContent = await tripsEntry.getData(tripsWriter);
		// console.log(tripsContent);

		const trips = CSVParse(tripsContent, { skipFirstRow: true });
		await env.KV.put('gtfs_trips', JSON.stringify(trips));

		const gtfsrt = await fetch('https://cdn.simplifytransit.com/metrolink/alerts/service-alerts.pb');
		const buffer = await gtfsrt.arrayBuffer();
		const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

		const alerts = feed.entity.filter((entity) => entity.alert);
		// console.log(alerts);

		const twitter = new Rettiwt({ apiKey: env.TWITTER_API });
		const bsky = new Bot({
			emitEvents: false,
			emitChatEvents: false,
		});
		await bsky.login({ identifier: 'metrolert.bsky.social', password: env.BSKY_PASSWORD });

		for (const alert of alerts) {
			const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(alert)));

			const hashHex = Array.from(new Uint8Array(hashBuffer))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');

			const currentHex = await env.KV.get(`alert_${alert.id}`);
			if (currentHex === hashHex) {
				continue;
			}

			// post lol
			// console.log('new alert', alert, hashHex);

			const tweetText = `🚨 ${alert.alert?.headerText?.translation?.[0]?.text || 'Service Alert'}

${alert.alert?.descriptionText?.translation?.[0]?.text || 'No additional details available'}

${alert.alert?.informedEntity
	?.map((entity) => {
		if (entity.trip?.tripId) {
			// Find the route ID from the static GTFS trips data
			const trip = trips.find((t) => t.trip_id === entity.trip?.tripId);
			return trip ? `🛤️ ${trip.route_id} 🚆 ${trip.trip_short_name} 📍 ${trip.trip_headsign}` : '';
		}
		return '';
	})
	.filter(Boolean)
	.join('\n')}

${alert.alert?.url?.translation?.[0]?.text ? `🔗 ${alert.alert.url.translation[0].text}` : ''}`;

			const bskyText = [
				`🚨 ${alert.alert?.headerText?.translation?.[0]?.text || 'Service Alert'}

${alert.alert?.descriptionText?.translation?.[0]?.text || 'No additional details available'}`,
				`${alert.alert?.informedEntity
					?.map((entity) => {
						if (entity.trip?.tripId) {
							// Find the route ID from the static GTFS trips data
							const trip = trips.find((t) => t.trip_id === entity.trip?.tripId);
							return trip ? `🛤️ ${trip.route_id} 🚆 ${trip.trip_short_name} 📍 ${trip.trip_headsign}` : '';
						}
						return false;
					})
					.filter(Boolean)
					.join('\n')}

${alert.alert?.url?.translation?.[0]?.text ? `🔗 ${alert.alert.url.translation[0].text}` : ''}`,
			];

			try {
				await twitter.tweet.post({
					text: tweetText,
				});

				const bsky1 = await bsky.post({
					text: bskyText[0],
				});

				await bsky1.reply({
					text: bskyText[1],
				});
			} catch (error) {
				console.error('Error posting tweet:', error);
			}
			await env.KV.put(`alert_${alert.id}`, hashHex);
		}

		// console.log(`trigger fired at ${event.cron}: ${true}`);
	},
} satisfies ExportedHandler<Env>;
