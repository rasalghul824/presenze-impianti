/*
  LETTORE BADGE PRESENZE — un lettore per ogni impianto
  -----------------------------------------------------
  Componenti: ESP32 DevKit V1 (30 pin) + lettore RFID RC522 + cicalino attivo

  COLLEGAMENTI (cavetti femmina-femmina):
    RC522 3.3V -> ESP32 3V3        (MAI al pin VIN/5V: il lettore si brucia)
    RC522 RST  -> ESP32 D22
    RC522 GND  -> ESP32 GND (lato destro, vicino a 3V3)
    RC522 IRQ  -> non collegato
    RC522 MISO -> ESP32 D19
    RC522 MOSI -> ESP32 D23
    RC522 SCK  -> ESP32 D18
    RC522 SDA  -> ESP32 D5
    Cicalino +  -> ESP32 D4   (gamba lunga / segno +)
    Cicalino -  -> ESP32 GND (lato sinistro, vicino a VIN)

  SUONI:
    1 bip lungo   = timbratura registrata
    2 bip corti   = niente internet: la timbratura è in memoria e verrà inviata dopo
    3 bip corti   = badge non associato o chiave sbagliata (guarda la dashboard)

  Libreria necessaria (Arduino IDE > Gestione librerie): "MFRC522" di GithubCommunity
  Scheda (Arduino IDE > Gestore schede): "esp32" di Espressif, poi scegli "ESP32 Dev Module"
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>

// ===================== DA COMPILARE PER OGNI IMPIANTO =====================
const char* WIFI_NOME     = "NOME-DEL-WIFI";
const char* WIFI_PASSWORD = "PASSWORD-DEL-WIFI";
const char* CHIAVE        = "INCOLLA-QUI-LA-CHIAVE-DELL-IMPIANTO";
const char* SITO          = "https://kaleidoscopic-pegasus-6d3541.netlify.app";  // indirizzo del tuo sito
// ==========================================================================

#define PIN_SS   5
#define PIN_RST  22
#define PIN_BUZ  4

MFRC522 rfid(PIN_SS, PIN_RST);

// Coda delle timbrature non ancora inviate (es. internet assente)
struct Timbratura { String uid; unsigned long letto; };
const int MAX_CODA = 40;
Timbratura coda[MAX_CODA];
int nCoda = 0;

String ultimoUid = "";
unsigned long ultimoMs = 0;
unsigned long ultimoTentativo = 0;

void bip(int volte, int durata) {
  for (int i = 0; i < volte; i++) {
    digitalWrite(PIN_BUZ, HIGH); delay(durata);
    digitalWrite(PIN_BUZ, LOW);  delay(90);
  }
}

// 1 = registrata, 0 = riprova più tardi, -1 = rifiutata (badge sconosciuto o chiave errata)
int invia(const Timbratura& t) {
  if (WiFi.status() != WL_CONNECTED) return 0;
  WiFiClientSecure client;
  client.setInsecure();               // connessione cifrata senza controllo certificato
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, String(SITO) + "/api/device/checkin")) return 0;
  http.addHeader("Content-Type", "application/json");
  unsigned long secondiFa = (millis() - t.letto) / 1000;
  String corpo = String("{\"key\":\"") + CHIAVE + "\",\"uid\":\"" + t.uid + "\",\"ago\":" + secondiFa + "}";
  int codice = http.POST(corpo);
  String risposta = http.getString();
  http.end();
  Serial.printf("Invio badge %s -> %d %s\n", t.uid.c_str(), codice, risposta.c_str());
  if (codice == 200) return 1;
  if (codice == 400 || codice == 401 || codice == 404) return -1;
  return 0;
}

void mettiInCoda(const Timbratura& t) {
  if (nCoda >= MAX_CODA) {            // coda piena: scarta la più vecchia
    for (int i = 1; i < MAX_CODA; i++) coda[i - 1] = coda[i];
    nCoda--;
  }
  coda[nCoda++] = t;
}

void svuotaCoda() {
  while (nCoda > 0) {
    int r = invia(coda[0]);
    if (r == 0) return;               // ancora niente internet: riprova dopo
    for (int i = 1; i < nCoda; i++) coda[i - 1] = coda[i];
    nCoda--;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZ, OUTPUT);
  digitalWrite(PIN_BUZ, LOW);

  SPI.begin();                        // SCK=18, MISO=19, MOSI=23
  rfid.PCD_Init();
  Serial.print("Lettore RC522 versione: 0x");
  Serial.println(rfid.PCD_ReadRegister(MFRC522::VersionReg), HEX);  // 0x91 o 0x92 = collegato bene

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_NOME, WIFI_PASSWORD);
  Serial.print("Connessione al WiFi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " collegato!" : " non riuscita (riprovo in automatico)");

  bip(1, 60); delay(120); bip(1, 60);  // due bip all'accensione = pronto
}

void loop() {
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      if (rfid.uid.uidByte[i] < 0x10) uid += "0";
      uid += String(rfid.uid.uidByte[i], HEX);
    }
    uid.toUpperCase();
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();

    // ignora lo stesso badge passato di nuovo entro 5 secondi
    if (uid == ultimoUid && millis() - ultimoMs < 5000) return;
    ultimoUid = uid; ultimoMs = millis();
    Serial.println("Badge letto: " + uid);

    Timbratura t = { uid, millis() };
    int r = invia(t);
    if (r == 1)       bip(1, 400);
    else if (r == -1) bip(3, 100);
    else { mettiInCoda(t); bip(2, 100); }
  }

  // ogni 15 secondi riprova a inviare quelle rimaste in coda
  if (nCoda > 0 && millis() - ultimoTentativo > 15000) {
    ultimoTentativo = millis();
    svuotaCoda();
  }
  delay(50);
}
