package com.fourpx.mobile

import java.time.LocalTime
import java.time.format.DateTimeFormatter

object AppLog {
    private const val MAX_LINES = 200
    private val lines = ArrayDeque<String>()
    private val timeFmt = DateTimeFormatter.ofPattern("HH:mm:ss")

    @Synchronized
    fun i(tag: String, msg: String) {
        addLine("I", tag, msg)
    }

    @Synchronized
    fun e(tag: String, msg: String) {
        addLine("E", tag, msg)
    }

    @Synchronized
    fun clear() {
        lines.clear()
    }

    @Synchronized
    fun dump(): String {
        return lines.joinToString("\n")
    }

    private fun addLine(level: String, tag: String, msg: String) {
        val ts = LocalTime.now().format(timeFmt)
        lines.addLast("$ts $level/$tag $msg")
        while (lines.size > MAX_LINES) {
            lines.removeFirst()
        }
    }
}
