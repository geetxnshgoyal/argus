import 'package:argus/src/wifi_room.dart';
import 'package:flutter_test/flutter_test.dart';

// Routers surveyed in Tower C (2026-09-29 to 10-09). Each router broadcasts several networks,
// so BSSIDs differ in the last octet.
final rooms = WifiRooms.fromJson({
  'ssid_prefix': 'SVYASA',
  'rooms': [
    {'room': 'Classroom 6', 'routers': ['e0:c2:50:78:3f', 'e0:c2:50:78:4b']},
    {'room': 'Classroom 8', 'routers': ['e0:c2:50:78:0e', 'e0:c2:50:78:3b']},
    {'room': 'Classroom 9', 'routers': ['e0:c2:50:77:91', 'e0:c2:50:76:c8']},
  ],
});

Map<String, dynamic> ap(String bssid, int rssi, [String ssid = 'SVYASA_STUDENTS']) => {'bssid': bssid, 'ssid': ssid, 'rssi': rssi};

void main() {
  test('Room 6 by router 1: the loudest listed router wins, even with Classroom 8 next door', () {
    final snap = {
      'connected': {'bssid': 'e0:c2:50:78:4b:a8', 'ssid': 'SVYASA_STUDENTS'},
      'seen': [ap('e0:c2:50:78:3f:a8', -41), ap('e0:c2:50:77:94:68', -53), ap('E0:C2:50:78:4B:A8', -55), ap('e0:c2:50:78:0e:a8', -64)],
    };
    expect(guessRoom(snap, rooms), const WifiGuess(WifiPlace.room, 'Classroom 6'));
  });

  test('only routers no room lists yet → on college Wi-Fi, room unknown', () {
    expect(guessRoom({'connected': null, 'seen': [ap('e0:c2:50:76:e8:a8', -47)]}, rooms), const WifiGuess(WifiPlace.campus));
  });

  test('home Wi-Fi or a hotspot → not near college Wi-Fi; nothing to read → no answer', () {
    expect(guessRoom({'connected': null, 'seen': [ap('22:f5:ee:d6:b7:64', -63, 'Galaxy A14')]}, rooms), const WifiGuess(WifiPlace.notCampus));
    expect(guessRoom({'connected': null, 'seen': []}, rooms), isNull);
    expect(guessRoom(null, rooms), isNull);
  });

  test('router id: first five octets; placeholders ignored', () {
    expect(routerId('E0-C2-50-76-E0-A8'), 'e0:c2:50:76:e0');
    expect(routerId('02:00:00:00:00:00'), isNull);
  });
}
