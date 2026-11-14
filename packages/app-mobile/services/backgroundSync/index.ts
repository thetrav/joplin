import { AppRegistry, DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import Setting from '@joplin/lib/models/Setting';
import { reg } from '@joplin/lib/registry';
import ResourceFetcher from '@joplin/lib/services/ResourceFetcher';
import KvStore from '@joplin/lib/services/KvStore';
import { noteLockKeyConflict } from '@joplin/lib/services/synchronizer/syncInfoUtils';
import { _ } from '@joplin/lib/locale';
import Logger from '@joplin/utils/Logger';
import checkPermissions from '../../utils/checkPermissions';

const logger = Logger.create('backgroundSync');

// Must match TASK_KEY and STOPPED_EVENT in BackgroundSyncJobService.java, and SYNC_IN_PROGRESS_TASK_KEY in
// BackgroundSyncPackage.java
const taskName = 'JoplinBackgroundSync';
const stoppedEventName = 'JoplinBackgroundSyncStopped';
const syncInProgressTaskName = 'JoplinSyncInProgress';

interface BackgroundSyncNativeModule {
	schedule(intervalMinutes: number, wifiOnly: boolean, notificationTitle: string, channelName: string): Promise<void>;
	cancel(): Promise<void>;
	syncStarted(notificationTitle: string, channelName: string): void;
	syncFinished(): void;
	showSyncAlert(title: string, text: string, channelName: string): void;
	hideSyncAlert(): void;
}

const nativeModule: BackgroundSyncNativeModule|null = Platform.OS === 'android' ? NativeModules.BackgroundSyncModule : null;

const isEnabled = () => {
	return Setting.value('sync.backgroundSync') && Setting.value('sync.interval') > 0 && Setting.value('sync.target') !== 0;
};

// Attachments are downloaded by ResourceFetcher after the sync completes, so a sync isn't finished until it's idle.
// autoAddResources also queues attachments left over from earlier syncs.
const waitForAttachmentDownloads = async () => {
	void ResourceFetcher.instance().autoAddResources();
	await ResourceFetcher.instance().waitForAllFinished();
};

const notificationTitle = () => _('Synchronising...');
const channelName = () => _('Background synchronisation');

// On Android 13+ the foreground service still runs without this permission, but its notification is hidden.
export const requestNotificationPermission = async () => {
	if (!nativeModule) return;
	const response = await checkPermissions(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
	if (response === PermissionsAndroid.RESULTS.DENIED) logger.warn('POST_NOTIFICATIONS permission was not granted');
};

const noteLockConflictAlertKey = 'backgroundSync.noteLockConflictAlertKeyId';

// Sync stops until the user migrates their locked notes in the app, so a background sync alerts them once per conflicting key.
const updateNoteLockConflictAlert = async (canAlert: boolean) => {
	const conflict = noteLockKeyConflict();
	const alertedKeyId = await KvStore.instance().value(noteLockConflictAlertKey);
	if (!conflict) {
		if (!alertedKeyId) return;
		nativeModule.hideSyncAlert();
		await KvStore.instance().deleteValue(noteLockConflictAlertKey);
		return;
	}
	if (!canAlert || alertedKeyId === conflict.noteLockKey.id) return;

	logger.info('Background sync stopped by a note lock key conflict - alerting the user');
	nativeModule.showSyncAlert(
		_('Synchronisation stopped'),
		_('Your locked notes must be migrated before synchronisation can continue. Open Joplin to migrate them.'),
		_('Synchronisation alerts'),
	);
	await KvStore.instance().setValue(noteLockConflictAlertKey, conflict.noteLockKey.id);
};

export const updateBackgroundSyncSchedule = async () => {
	if (!nativeModule) return;

	if (!isEnabled()) {
		await nativeModule.cancel();
		return;
	}

	const intervalMinutes = Setting.value('sync.interval') / 60;
	logger.info(`Scheduling background sync every ${intervalMinutes} minutes (or at the shortest interval Android allows)`);
	await nativeModule.schedule(intervalMinutes, Setting.value('sync.mobileWifiOnly'), notificationTitle(), channelName());
};

let syncCount = 0;

// Lets a sync started in the app continue if the app is closed or the screen turns off (see
// BackgroundSyncModule.syncStarted)
export const onSyncStarted = () => {
	syncCount++;
	if (!nativeModule || !isEnabled()) return;
	nativeModule.syncStarted(notificationTitle(), channelName());
};

export const onSyncCompleted = async () => {
	if (!nativeModule) return;

	const syncCountAtCompletion = syncCount;
	try {
		await updateNoteLockConflictAlert(false);
		if (isEnabled()) {
			logger.info('Sync completed - waiting for attachment downloads');
			await waitForAttachmentDownloads();
		}
	} catch (error) {
		logger.warn('Error while finishing the sync:', error);
	}
	// A sync started while downloading now owns the foreground service.
	if (syncCountAtCompletion === syncCount) nativeModule.syncFinished();
};

// initializeApp must be safe to call when the app is already initialised in this JS runtime.
export const registerBackgroundSyncTask = (initializeApp: ()=> Promise<void>) => {
	if (!nativeModule) return;

	// Started natively alongside a sync. While it runs, React Native keeps JS timers running in the background.
	AppRegistry.registerHeadlessTask(syncInProgressTaskName, () => async () => {
		const synchronizer = await reg.syncTarget().synchronizer();
		await synchronizer.waitForSyncToFinish();
		await waitForAttachmentDownloads();
	});

	AppRegistry.registerHeadlessTask(taskName, () => async () => {
		let stopped = false;
		let ownSyncRunning = false;
		let resolveStopped: ()=> void;
		const stoppedPromise = new Promise<void>(resolve => { resolveStopped = resolve; });
		const stopListener = DeviceEventEmitter.addListener(stoppedEventName, async () => {
			stopped = true;
			resolveStopped();
			// A sync started by the app (which this task may be waiting on) is left alone.
			if (!ownSyncRunning) return;

			logger.info('Android stopped the background task - cancelling sync');
			const synchronizer = await reg.syncTarget().synchronizer();
			await synchronizer.cancel();
		});

		try {
			await initializeApp();
			if (!isEnabled()) return;

			const synchronizer = await reg.syncTarget().synchronizer();
			await synchronizer.waitForSyncToFinish();
			if (stopped) return;

			logger.info('Starting background sync');
			ownSyncRunning = true;
			// The network constraint (including Wi-Fi only) is enforced by the job scheduler.
			await reg.scheduleSync(0, null, false);
			ownSyncRunning = false;
			await updateNoteLockConflictAlert(true);
			if (stopped) return;

			// If the process is then killed, interrupted downloads are reset and retried on the next start.
			logger.info('Background sync finished - waiting for attachment downloads');
			await Promise.race([waitForAttachmentDownloads(), stoppedPromise]);
			logger.info(stopped ? 'Android stopped the background task during attachment downloads' : 'Attachment downloads finished');
		} catch (error) {
			logger.error('Background sync failed:', error);
		} finally {
			ownSyncRunning = false;
			stopListener.remove();
		}
	});
};
