import 'package:argus/src/wifi_room.dart';
import 'package:flutter_test/flutter_test.dart';

// A typical floor: each router broadcasts several networks, so BSSIDs differ in the last octet.
final rooms = WifiRooms.fromJson({
  'ssid_prefix': 'CAMPUS',
  'rooms': [
    {'room': 'Classroom 6', 'routers': ['0a:1b:2c:78:3f', '0a:1b:2c:78:4b']},
    {'room': 'Classroom 8', 'routers': ['0a:1b:2c:78:0e', '0a:1b:2c:78:3b']},
    {'room': 'Classroom 9', 'routers': ['0a:1b:2c:77:91', '0a:1b:2c:76:c8']},
  ],
});

Map<String, dynamic> ap(String bssid, int rssi, [String ssid = 'CAMPUS_STUDENTS']) => {'bssid': bssid, 'ssid': ssid, 'rssi': rssi};

void main() {
  test('Room 6 by router 1: the loudest listed router wins, even with Classroom 8 next door', () {
    final snap = {
      'connected': {'bssid': '0a:1b:2c:78:4b:a8', 'ssid': 'CAMPUS_STUDENTS'},
      'seen': [ap('0a:1b:2c:78:3f:a8', -41), ap('0a:1b:2c:77:94:68', -53), ap('0A:1B:2C:78:4B:A8', -55), ap('0a:1b:2c:78:0e:a8', -64)],
    };
    expect(guessRoom(snap, rooms), const WifiGuess(WifiPlace.room, 'Classroom 6', -41));
  });

  test('still connected to Classroom 8\'s router, but Classroom 9\'s is louder → Classroom 9', () {
    // The phone stayed on the router it joined next door; the scan says where it is now.
    final snap = {
      'connected': {'bssid': '0a:1b:2c:78:0e:a8', 'ssid': 'CAMPUS_STUDENTS', 'rssi': -71},
      'seen': [ap('0a:1b:2c:77:91:68', -44), ap('0a:1b:2c:78:0e:a8', -71)],
    };
    expect(guessRoom(snap, rooms)?.room, 'Classroom 9');
  });

  test('no flicker: the room shown stays unless another is clearly louder', () {
    final close = {'connected': null, 'seen': [ap('0a:1b:2c:78:3f:a8', -50), ap('0a:1b:2c:78:0e:a8', -48)]};
    expect(guessRoom(close, rooms, previous: 'Classroom 6')?.room, 'Classroom 6');
    expect(guessRoom(close, rooms)?.room, 'Classroom 8');
    final clear = {'connected': null, 'seen': [ap('0a:1b:2c:78:3f:a8', -60), ap('0a:1b:2c:78:0e:a8', -45)]};
    expect(guessRoom(clear, rooms, previous: 'Classroom 6')?.room, 'Classroom 8');
  });

  test('only routers no room lists yet → on college Wi-Fi, room unknown', () {
    expect(guessRoom({'connected': null, 'seen': [ap('0a:1b:2c:76:e8:a8', -47)]}, rooms), const WifiGuess(WifiPlace.campus));
  });

  test('home Wi-Fi or a hotspot → not near college Wi-Fi; nothing to read → no answer', () {
    expect(guessRoom({'connected': null, 'seen': [ap('22:f5:ee:d6:b7:64', -63, 'Phone hotspot')]}, rooms), const WifiGuess(WifiPlace.notCampus));
    expect(guessRoom({'connected': null, 'seen': []}, rooms), isNull);
    expect(guessRoom(null, rooms), isNull);
  });

  test('router id: first five octets; placeholders ignored', () {
    expect(routerId('0A-1B-2C-76-E0-A8'), '0a:1b:2c:76:e0');
    expect(routerId('02:00:00:00:00:00'), isNull);
  });
}
