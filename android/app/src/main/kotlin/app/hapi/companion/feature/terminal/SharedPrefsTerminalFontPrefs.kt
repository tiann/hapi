package app.hapi.companion.feature.terminal

import android.content.Context
import android.content.SharedPreferences

/**
 * [TerminalFontPrefs] over SharedPreferences ("terminal_prefs"/"font_size_sp"):
 * font stepping survives app restarts, mirroring the web route's localStorage
 * persistence. Only ladder values are ever written, so `> 0` is enough of a
 * validity check on read.
 */
class SharedPrefsTerminalFontPrefs(context: Context) : TerminalFontPrefs {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(): Int? = prefs.takeIf { it.contains(KEY_FONT_SIZE_SP) }
        ?.getInt(KEY_FONT_SIZE_SP, 0)
        ?.takeIf { it > 0 }

    override fun save(sizeSp: Int) {
        prefs.edit().putInt(KEY_FONT_SIZE_SP, sizeSp).apply()
    }

    private companion object {
        const val PREFS_NAME = "terminal_prefs"
        const val KEY_FONT_SIZE_SP = "font_size_sp"
    }
}
