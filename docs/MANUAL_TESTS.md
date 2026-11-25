# PsstAmigo — Manuel Test Listesi (test sürümü)

**Adres:** https://bisbiliroglu.github.io/psstamigo/
**Sürüm:** başlıkta yazan sürümü (ör. `v0.0.2`) raporuna mutlaka yaz.

> Bu bir **test sürümüdür**, kararlı sürüm değildir. Şimdilik sadece **iki kişilik (1:1)** görüşme var.
> UID'ni yalnızca güvendiğin kişilerle paylaş: UID'ni bilen biri, sen isteği kabul etmeden önce bile IP adresini öğrenebilir.

## Hazırlık

- Windows'ta **güncel Chrome veya Edge** kullan.
- Sesli testlerde **kulaklık** tak (yankı/geri besleme olmasın).
- Görev Yöneticisi'ni (Ctrl+Shift+Esc) açık tut — CPU/RAM gözlemi için.
- Sorun olursa: sayfadaki **"Bağlantı tanılama"** panelini aç ve oradaki değerleri (IP adresi olmadan) not al.

## Raporlarken DİKKAT

- **Gerçek IP adresi, konuşma içeriği, kişisel bilgi yazma.** Tanılama panelinde zaten IP gösterilmez; sadece `host/srflx` gibi bağlantı türleri görünür.
- Yapmadığın testi **NOT RUN** olarak bırak. Emin olmadığın şeyi PASS yapma.

---

## A. Ağ senaryoları

Her senaryoda B bölümündeki temel akışı (B-01…B-10) uygula ve sonucu şablonla raporla.

| ID | Senaryo | Not |
|---|---|---|
| N-01 | Aynı bilgisayar, iki ayrı tarayıcı penceresi (normal + Gizli/InPrivate) | En kolay başlangıç |
| N-02 | Aynı ev ağında (LAN) iki bilgisayar | |
| N-03 | Farklı internet bağlantıları (iki ayrı ev / iki ayrı servis sağlayıcı) | |
| N-04 | Ev interneti ↔ telefondan mobil hotspot | Bağlanmazsa hata mesajı görünmeli |
| N-05 | Mobil hotspot ↔ mobil hotspot (mümkünse farklı operatörler) | TURN olmadığı için başarısız olabilir; **sahte "bağlandı" görünmemeli** |

## B. Temel işlevler

| ID | Adım | Beklenen |
|---|---|---|
| B-01 | Sayfayı aç | Mikrofon/kamera izni **sorulmaz**. "Sinyal: çevrimiçi" ve `psst-xxxx-xxxx-xxxx` biçiminde UID görünür |
| B-02 | "Kopyala" ile UID'yi kopyala, arkadaşına gönder | UID panoya kopyalanır |
| B-03 | Arkadaşın senin UID'ni girip "Bağlan"a basar | Sende istek kutusu çıkar (ad + UID) |
| B-04 | "Reddet" | Karşı tarafta "reddedildi" mesajı; görüşme başlamaz |
| B-05 | Tekrar istek → "Kabul et" | İki tarafta katılımcı görünür, birkaç saniye içinde **"ses bağlı"** |
| B-06 | İki yönlü mesaj gönder | Mesajlar karşı tarafa gelir, saat + ad ile görünür |
| B-07 | Mikrofon butonuna bas | Tarayıcı izin sorar → izin ver. Etiket "Mikrofon açık", konuşunca **mikrofon göstergesi hareket eder** |
| B-08 | Karşı taraf hoparlörü açar | Sesin duyulur; onun **hoparlör göstergesi** ve senin satırındaki gösterge hareket eder |
| B-09 | İki yönlü sesli konuşma | Her iki taraf da birbirini duyar |
| B-10 | "Ayrıl" | İki tarafta "Aktif görüşme yok."; mesajlar silinir; UID'n değişmez |
| B-11 | Geçersiz UID gir (ör. `psst-1234`) | "Geçersiz UID" mesajı |
| B-12 | Kendi UID'ni gir | "Kendinize bağlanamazsınız" |
| B-13 | Görüşme sırasında karşı taraf sekmesini kapatır | Sende birkaç saniye (en geç ~30 sn) içinde görüşme biter |

## C. Gizlilik kontrolleri (en önemlisi)

| ID | Adım | Beklenen |
|---|---|---|
| P-01 | Sayfayı ilk aç | Hiçbir izin penceresi yok; adres çubuğunda mikrofon/kamera simgesi yok |
| P-02 | Görüşmeyi kabul et, mikrofona dokunma | Tarayıcı sekmesinde **kırmızı kayıt noktası yok**; karşı taraf seni duymuyor |
| P-03 | Mikrofonu aç, sonra kapat | Kapatınca sekmedeki **kırmızı kayıt noktası 1–2 sn içinde kaybolur**; Windows görev çubuğundaki mikrofon simgesi de kaybolur |
| P-04 | Mikrofon kapalıyken konuş | Karşı taraf **hiçbir şey duymaz**; onun göstergesi hareket etmez |
| P-05 | Hoparlör kapalıyken karşı taraf konuşur | **Hiç ses gelmez**; hoparlör göstergesi hareketsiz |
| P-06 | Mikrofon ve hoparlörü bağımsız aç/kapat | Biri diğerini değiştirmez |
| P-07 | Görüşmeye yeni katılınca / bağlantı kurulunca | Mikrofon ve hoparlör **kendiliğinden açılmaz** |
| P-08 | Konuşurken sekmeyi kapat | Karşı tarafta ses kesilir; senin tarafında kayıt simgesi kalmaz |
| P-09 | Mikrofon açıkken sayfayı yenile (F5) | Görüşme biter, **yeni UID** gelir, mikrofon kapalı başlar |
| P-10 | Mikrofon izni penceresi açıkken "Ayrıl" | İzin versen bile mikrofon açık kalmaz, kayıt simgesi görünmez |
| P-11 | Mikrofon iznini reddet | Hata mesajı; **mesajlaşma ve karşı tarafı dinleme çalışmaya devam eder** |
| P-12 | Tüm test boyunca | **Kamera veya ekran paylaşımı izni hiç istenmez** |

## D. Oyun sırasında (Windows, Chrome ve Edge ayrı ayrı)

| ID | Adım | Beklenen / gözlem |
|---|---|---|
| G-01 | Görüşme sırasında Alt+Tab | Görüşme devam eder |
| G-02 | Tarayıcıyı simge durumuna küçült | Görüşme devam eder |
| G-03 | Tam ekran bir oyun aç | Görüşme devam eder |
| G-04 | 15–30 dk kesintisiz sesli konuşma | Kopma, robotik ses, gecikme var mı? Kaç kez? |
| G-05 | Gecikme hissi | "Yok / az / belirgin / rahatsız edici" |
| G-06 | CPU / RAM | Görev Yöneticisi → tarayıcı işlemi: oyun öncesi, görüşme sırasında, 15. ve 30. dakikada not al |
| G-07 | Oyun performansı | FPS düşüşü/takılma hissediliyor mu? (oyunun kendi FPS göstergesi varsa değeri yaz) |

### Uzun görüşme ölçüm önerisi (30+ dk)

1. Görüşmeye başlarken "Bağlantı tanılama" panelini aç.
2. Her 5 dakikada bir **RTT**, **jitter**, **paket kaybı** değerlerini ve Görev Yöneticisi'ndeki tarayıcı **CPU %** / **bellek** değerini tabloya yaz.
3. Kesinti olduğunda saatini ve ne kadar sürdüğünü not al (katılımcı satırında "ses kesintide…" görünür).
4. Sonunda değerlerin zamanla artıp artmadığına bak (bellek sürekli artıyorsa bildir).

| Dakika | RTT | Jitter | Paket kaybı | CPU % | Bellek | Not |
|---|---|---|---|---|---|---|
| 0 | | | | | | |
| 5 | | | | | | |
| … | | | | | | |

---

## Rapor şablonu

Her test için bir satır doldur (kopyala-yapıştır):

```
Test ID:
Sürüm (başlıktaki):
Tarayıcı ve işletim sistemi:        (ör. Edge 14x / Windows 11)
Ağ türü (iki taraf):                (ör. ev fiber ↔ mobil hotspot)
Bağlantı sonucu:                    (bağlandı / bağlanamadı + gösterilen mesaj)
Bağlantı yolu (tanılama "yol"):     (ör. srflx ↔ srflx (udp))
Ses kalitesi:                       (iyi / orta / kötü + açıklama)
RTT:
Jitter:
Paket kaybı:
CPU / RAM gözlemi:
Gizlilik doğrulaması:               (ör. P-03 kayıt noktası kayboldu mu?)
Sonuç:                              PASS / FAIL / NOT RUN
Notlar:                             (IP adresi, konuşma içeriği veya kişisel bilgi YAZMA)
```
