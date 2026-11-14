package net.cozic.joplin.backgroundsync;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

// Keeps the process at foreground priority while a long sync runs, so it isn't suspended when the app is closed
// or cut off by the job time limit. Android 12+ only allows starting it from the background (from a sync job)
// when the app is exempt from battery optimisation; the job then runs with the normal limit and resumes next time.
public class BackgroundSyncForegroundService extends Service {
	private static final String TAG = "JoplinBackgroundSync";
	static final String PREFS_NAME = "joplin_background_sync";
	static final String PREF_NOTIFICATION_TITLE = "notificationTitle";
	static final String PREF_CHANNEL_NAME = "channelName";
	private static final String CHANNEL_ID = "joplin_background_sync";
	private static final int NOTIFICATION_ID = 0x4a5359;

	private static final long WAKE_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000;

	// Sync jobs and a sync continued from the app can overlap
	private static int activeJobCount = 0;

	// Keeps the CPU running with the screen off
	private PowerManager.WakeLock wakeLock;

	// Returns false if Android refused to start the service
	static synchronized boolean acquire(Context context) {
		activeJobCount++;
		if (activeJobCount > 1) return true;

		Intent intent = new Intent(context, BackgroundSyncForegroundService.class);
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				context.startForegroundService(intent);
			} else {
				context.startService(intent);
			}
			return true;
		} catch (IllegalStateException e) {
			Log.i(TAG, "Could not start background sync foreground service: " + e);
			return false;
		}
	}

	static synchronized void release(Context context) {
		if (activeJobCount == 0) return;
		activeJobCount--;
		if (activeJobCount == 0) context.stopService(new Intent(context, BackgroundSyncForegroundService.class));
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				startForeground(NOTIFICATION_ID, createNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
			} else {
				startForeground(NOTIFICATION_ID, createNotification());
			}
		} catch (IllegalStateException e) {
			Log.i(TAG, "Could not promote background sync to the foreground: " + e);
			stopSelf();
			return START_NOT_STICKY;
		}

		if (wakeLock == null) {
			wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Joplin:BackgroundSync");
			wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
		}
		return START_NOT_STICKY;
	}

	@Override
	public void onDestroy() {
		if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
		wakeLock = null;
		super.onDestroy();
	}

	// Android 15+ limits dataSync foreground services to about 6 hours a day, and crashes the app if the
	// service isn't stopped promptly once the limit is reached.
	@Override
	public void onTimeout(int startId, int fgsType) {
		stopSelf();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}

	private Notification createNotification() {
		SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			NotificationChannel channel = new NotificationChannel(
				CHANNEL_ID,
				prefs.getString(PREF_CHANNEL_NAME, "Background sync"),
				NotificationManager.IMPORTANCE_LOW
			);
			getSystemService(NotificationManager.class).createNotificationChannel(channel);
		}

		return new NotificationCompat.Builder(this, CHANNEL_ID)
			.setContentTitle(prefs.getString(PREF_NOTIFICATION_TITLE, "Synchronising..."))
			.setSmallIcon(android.R.drawable.stat_notify_sync)
			.setOngoing(true)
			.setSilent(true)
			.build();
	}
}
