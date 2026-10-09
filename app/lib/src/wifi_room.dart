/// "Which room am I near?" for the Home card (Android only, ADR-0030).
///
/// The phone compares the Wi-Fi routers it can see with each room's routers
/// (from `/v1/me/wifi-rooms`). Everything happens on the phone; the scan isn't
/// sent anywhere for this. A router broadcasts several networks whose BSSIDs
/// differ only in the last octet, so a router is the first five octets.
library;

/// Rooms' routers, as the server lists them.
class WifiRooms {
  const WifiRooms({required this.ssidPrefix, required this.routers});

  final String ssidPrefix;

  /// Router id → room code.
  final Map<String, String> routers;

  factory WifiRooms.fromJson(Map<String, dynamic> j) {
    final routers = <String, String>{};
    for (final r in (j['rooms'] as List).cast<Map<String, dynamic>>()) {
      for (final id in (r['routers'] as List).cast<String>()) {
        routers[id] = r['room'] as String;
      }
    }
    return WifiRooms(ssidPrefix: j['ssid_prefix'] as String? ?? '', routers: routers);
  }
}

enum WifiPlace { room, campus, notCampus }

class WifiGuess {
  const WifiGuess(this.place, [this.room, this.rssi]);
  final WifiPlace place;

  /// The room whose router is heard loudest, when [place] is [WifiPlace.room].
  final String? room;

  /// That router's signal level in dBm (closer to 0 = nearer).
  final int? rssi;

  @override
  bool operator ==(Object other) => other is WifiGuess && other.place == place && other.room == room;

  @override
  int get hashCode => Object.hash(place, room);

  @override
  String toString() => 'WifiGuess($place, $room)';
}

final _mac = RegExp(r'^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$', caseSensitive: false);

/// "E0:C2:50:76:E0:A8" → "e0:c2:50:76:e0"; null for placeholders and junk.
String? routerId(String? bssid) {
  if (bssid == null || !_mac.hasMatch(bssid.trim())) return null;
  final parts = bssid.trim().toLowerCase().replaceAll('-', ':').split(':');
  final all = parts.join(':');
  if (all == '00:00:00:00:00:00' || all == '02:00:00:00:00:00') return null;
  return parts.take(5).join(':');
}

/// A neighbouring room must be this much louder (dB) to replace the room shown, so the card
/// doesn't flicker between two rooms whose routers are about equally loud.
const roomSwitchMarginDb = 4;

/// The room whose router is loudest in [snapshot] (`{connected, seen: [{bssid, ssid, rssi}]}`
/// from `SecurityBridge.wifiSnapshot`), whether or not the phone is connected to it. [previous]
/// is the room shown last time. Null when there's no Wi-Fi data to go on.
WifiGuess? guessRoom(Map<String, dynamic>? snapshot, WifiRooms rooms, {String? previous}) {
  if (snapshot == null) return null;
  final connected = snapshot['connected'] as Map<String, dynamic>?;
  final seen = ((snapshot['seen'] as List?) ?? const []).cast<Map<String, dynamic>>();
  final aps = [?connected, ...seen];
  if (aps.isEmpty) return null;

  final loudest = <String, int>{}; // room → its loudest router
  var onCampus = false;
  for (final ap in aps) {
    final id = routerId(ap['bssid'] as String?);
    final ssid = (ap['ssid'] as String?) ?? '';
    if (rooms.ssidPrefix.isNotEmpty && ssid.toLowerCase().startsWith(rooms.ssidPrefix.toLowerCase())) onCampus = true;
    final room = id == null ? null : rooms.routers[id];
    if (room == null) continue;
    onCampus = true;
    // iPhones give the connected router no signal level.
    final rssi = (ap['rssi'] as num?)?.toInt() ?? -100;
    if (rssi > (loudest[room] ?? -1000)) loudest[room] = rssi;
  }
  if (loudest.isNotEmpty) {
    final best = loudest.entries.reduce((a, b) => b.value > a.value ? b : a);
    final kept = previous == null ? null : loudest[previous];
    if (kept != null && best.value - kept < roomSwitchMarginDb) return WifiGuess(WifiPlace.room, previous, kept);
    return WifiGuess(WifiPlace.room, best.key, best.value);
  }
  return WifiGuess(onCampus ? WifiPlace.campus : WifiPlace.notCampus);
}
