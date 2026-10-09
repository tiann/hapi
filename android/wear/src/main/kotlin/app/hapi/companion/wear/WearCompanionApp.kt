package app.hapi.companion.wear

import android.app.Application

/** No DI graph: the watch holds no hub credentials — every data access is a
 *  request to [app.hapi.companion.wear.data.WatchRequests], answered by the
 *  phone's PhoneWearListenerService. */
class WearCompanionApp : Application()
