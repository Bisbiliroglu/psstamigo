# PsstAmigo — Manuel Test Listesi (test sürümü)

**Adres:** https://bisbiliroglu.github.io/psstamigo/
**Sürüm:** başlıkta yazan sürümü (ör. `v0.1.0`) raporuna mutlaka yaz.

> Bu bir **test sürümüdür**, kararlı sürüm değildir. v0.1.0 ile **en fazla 10 kişilik** grup görüşmesi var (bölüm E–G).
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

## Öncelikli 20 test (v0.1.1)

Önceki sürümlerin sonuçları geçmiş kayıt olarak durur; bu sürüm için geçerli değildir. Hepsi şu an **NOT RUN**.

| # | Kontrol | İlgili ID |
|---|---|---|
| 1 | Üç kişi farklı UID'ler üzerinden aynı görüşmeye katılabiliyor | GF-02 |
| 2 | Yeni kişi için herkesin onayı gerekiyor | GF-02, GF-07 |
| 3 | Bir kişi reddedince mevcut görüşme bozulmuyor | GF-07 |
| 4 | Yeni katılanın mikrofonu ve hoparlörü kapalı | GP-03, GP-04 |
| 5 | Yeni katılımcı onaydan önce ses duymuyor | GP-01 |
| 6 | Mikrofon kapatılınca hiçbir katılımcı sesini duymuyor | GP-06 |
| 7 | Tarayıcının mikrofon göstergesi kayboluyor | GP-06 |
| 8 | Hoparlör kapatılınca hiçbir katılımcının sesi duyulmuyor | GP-07 |
| 9 | Her katılımcının konuşma dalgası doğru kişide hareket ediyor | GP-08 |
| 10 | Grup mesajlaşması çalışıyor | GF-12 |
| 11 | Yeni katılan eski mesajları görmüyor | GP-02 |
| 12 | İlk başlatan ayrılınca diğerleri devam ediyor | GF-09 |
| 13 | Davet linki onaysız bağlantı başlatmıyor | GF-13 |
| 14 | 5'ten 6 kişiye geçince "düşük veri modu açık", 5'e dönünce kayboluyor; 6 kişide ses anlaşılır (aşağıdaki dinleme testi) | GF-04 |
| 15 | 10 kişilik görüşme kurulabiliyor | GF-05 |
| 16 | 11. katılımcı reddediliyor | GF-06 |
| 17 | Farklı internet sağlayıcılarıyla bağlantı | GN-01 |
| 18 | Windows Chrome ve Edge'de oyun sırasında görüşme sürüyor | GN-03 … GN-05 |
| 19 | Uzun kullanımda CPU/RAM ve ses kalitesi kabul edilebilir | GN-06, GN-07 |
| 20 | Sekme kapatılınca mikrofon kaydı ve ses iletişimi bitiyor; tarayıcı çökerse diğerlerinde en geç ~40 sn içinde "bağlantı koptu" | GF-10, GF-10b |

### Düşük veri modu dinleme testi (16 kbps)

1. 5 kişiyle bir cümleyi (ör. "Sol taraftan iki kişi geliyor") okuyun; bir dinleyici anlaşılırlığı 1–5 arasında puanlasın.
2. 6. kişi katılsın ("düşük veri modu açık" görünmeli); aynı cümleyi tekrar okuyun ve puanlayın.
3. Farkı ve anlaşılırlığı rapora yazın. Otomatik testler bunu ölçemez (sentetik bip sesi kullanır).

## E. Grup görüşmesi (v0.1.0+)

Yeni birini eklemek için: o kişi görüşmedeki **herhangi birinin** UID'sini girer veya davet linkini açar. Görüşmedeki **herkes** "Kabul et" demeden kimse katılamaz.

| ID | Senaryo | Beklenen |
|---|---|---|
| GF-01 | 2 kişilik görüşme | Durum: "Görüşmede 2/10 kişi var." |
| GF-02 | 3 kişilik görüşme (3. kişi, ilk başlatan dışındaki kişinin UID'siyle) | Herkeste 3/10; herkes iki kişiyi listede görür |
| GF-03 | 4 kişilik görüşme | Herkeste 4/10 |
| GF-04 | 6 kişilik görüşme | Durumda "düşük veri modu açık" yazar; ses anlaşılır mı? |
| GF-05 | 10 kişilik görüşme (mümkünse) | 10/10; ses kalitesi, gecikme, CPU notu |
| GF-06 | 11. kişi katılmaya çalışır | "Görüşme kapasitesi dolu." |
| GF-07 | Katılım isteğini mevcut katılımcılardan **biri** reddeder | Yeni kişi "reddedildi" görür; mevcut görüşme bozulmaz |
| GF-08 | Kimse yanıt vermez (~45 sn) | İstek zaman aşımına uğrar; görüşme bozulmaz |
| GF-09 | Görüşmeyi başlatan kişi ayrılır | Diğerleri konuşmaya ve yazışmaya devam eder |
| GF-10 | Bir katılımcı sekmesini kapatır | Diğerlerinde birkaç saniye içinde "ayrıldı" mesajı; görüşme devam eder |
| GF-10b | Bir katılımcının tarayıcısı çöker / interneti tamamen kesilir | Diğerlerinde ~10 sn içinde "ses kesintide/yok", en geç ~40 sn içinde "bağlantı koptu"; görüşme devam eder |
| GF-11 | Birden fazla kişi aynı anda konuşur | Herkes duyulur; her kişinin satırındaki dalga ayrı hareket eder |
| GF-12 | Grup mesajlaşması | Herkesin mesajı herkese bir kez gelir |
| GF-13 | Davet linki: "Davet linkini kopyala" → arkadaş linki açar | Arkadaşta "İstek gönder / Vazgeç" çıkar; tıklamadan istek gitmez; sonra normal onay |

## F. Grup gizliliği

| ID | Senaryo | Beklenen |
|---|---|---|
| GP-01 | Yeni kişi, onaylar tamamlanmadan | Hiç ses duymaz; katılımcı listesini görmez; mesaj almaz |
| GP-02 | Yeni kişi katıldıktan sonra | Eski mesajlar ona gelmez |
| GP-03 | Yeni kişinin mikrofonu | Otomatik açılmaz, izin penceresi çıkmaz |
| GP-04 | Yeni kişinin hoparlörü | Otomatik açılmaz |
| GP-05 | Mikrofonu kapalı bir üye varken yeni kişi katılır | O üyenin mikrofonu kapalı kalır (kayıt noktası yok) |
| GP-06 | Mikrofonunu kapat | Sekmedeki kayıt noktası kaybolur; **hiçbir** katılımcı seni duymaz |
| GP-07 | Hoparlörünü kapat | **Hiçbir** katılımcının sesi duyulmaz; dalgalar durur |
| GP-08 | Ses aktivitesi | Her katılımcının dalgası sadece o konuşurken hareket eder |
| GP-09 | Bir katılımcı ayrılır | Kalanların mikrofon/hoparlör durumu değişmez |

## G. Gerçek ağ ve performans (grup)

| ID | Senaryo | Not |
|---|---|---|
| GN-01 | Farklı internet sağlayıcılarından 3+ kişi | Bir çift bağlanamazsa yeni kişi katılamaz ve "bağlantı kurulamadı" görünür (TURN yok) |
| GN-02 | Ev interneti + mobil hotspot karışık grup | |
| GN-03 | Windows Chrome | |
| GN-04 | Windows Edge | |
| GN-05 | Oyun sırasında arka planda grup görüşmesi | |
| GN-06 | 15–30 dk kesintisiz grup görüşmesi | Kopma / robotik ses |
| GN-07 | CPU/RAM: 2, 3, 6 ve (mümkünse) 10 kişide | Görev Yöneticisi → tarayıcı |
| GN-08 | RTT, jitter, paket kaybı | "Teknik bağlantı bilgisi" panelinden, her katılımcı için |

## H. Bağlantı kurtarma (v0.2.0)

Her senaryo için: **Beklenen · Gözlenen · Toparlanma süresi · Bağlantı sonucu · Gizlilik sonucu · Tarayıcı/OS · Ağ türü · PASS / FAIL / NOT RUN**.
İnterneti kesmek için Wi-Fi'yi kapatıp açabilir veya ağ kablosunu çıkarabilirsiniz. Hepsi şu an **NOT RUN**.

| ID | Senaryo | Beklenen |
|---|---|---|
| R-01 | İki kişi konuşurken birinin interneti ~5 sn kesilir | "ses kesintide…", sonra kendiliğinden "ses bağlı"; görüşme bitmez |
| R-02 | İnternet ~15 sn kesilir | Aynı; gerekirse "ses yeniden kuruluyor…" ve sonra "ses yeniden bağlandı" |
| R-03 | İnternet uzun süre (1 dk+) kesilir | ~30–40 sn sonra diğerlerinde "bağlantı koptu"; kopan kişide görüşme biter ve "yeniden katılma" butonu çıkar |
| R-04 | Kopan kişi internete geri döner | Kendiliğinden görüşmeye girmez; butonla yeni istek gönderir, herkes onaylarsa katılır |
| R-05 | Bir kişinin tarayıcısı aniden kapatılır (Görev Yöneticisi) | Diğerlerinde en geç ~40 sn içinde "bağlantı koptu" |
| R-06 | Görüşmeyi başlatan kişinin bağlantısı kopar | Diğerleri devam eder |
| R-07 | 3 kişide biri ayrılırken diğer ikisi konuşur | İkisi kesintisiz devam eder |
| R-08 | Kesinti sırasında mikrofonu kapat | Bağlantı geri gelince mikrofon **kapalı kalır**, sekmede kayıt noktası yok |
| R-09 | Kesinti öncesi mikrofon açık, kesintide dokunma | Bağlantı geri gelince ses aynı onaylı kişiye yeniden gider (kullanıcı kararı); yeni izin penceresi açılmaz |
| R-10 | Kesinti sırasında hoparlörü kapat | Geri gelince hoparlör **kapalı kalır**, ses duyulmaz |
| R-11 | Hoparlör kesintide açık kaldıysa | Geri gelince ses yeniden duyulur |
| R-12 | Bağlantısı tamamen bitmiş kişi yeni istekle döner | Herkesin onayı gerekir |
| R-13 | Art arda 3–4 kısa kesinti | Uygulama çalışmaya devam eder, katılımcı listesi doğru |
| R-14 | Oyun sırasında (arka planda) kısa kesinti | Görüşme kendiliğinden toparlanır; gereksiz yere kimse çıkarılmaz |
| R-15 | Görüşmeden ayrıldıktan sonra | Hiçbir yeniden bağlanma denemesi sürmez; "Sinyal: çevrimiçi" dışında durum değişmez |
| R-16 | Sinyal sunucusuna erişilemiyor (ör. sadece WebSocket engelli ağ) | "Sinyal: yeniden bağlanıyor (n/8)", sonra "bağlanılamıyor" + "Yeniden dene"; mevcut görüşme sürer |

## I. Ses cihazları (v0.3.0)

Ayarlar: sol taraftaki **"Ses ayarları"**. Hepsi şu an **NOT RUN**. Otomatik testler sahte cihazlarla yapıldı; gerçek kulaklık/hoparlör yönlendirmesi yalnızca bu testlerle doğrulanır.

| ID | Test | Beklenen |
|---|---|---|
| D-01 | USB mikrofon ve webcam mikrofonu bağlıyken doğru cihazı seç | Listede ikisi de görünür; seçilen kullanılır |
| D-02 | Seçili cihazla "Mikrofonu test et" | Konuşunca test göstergesi hareket eder |
| D-03 | Test sırasında başka kullanıcı | Hiçbir şey duymaz |
| D-04 | Testi durdur / paneli kapat | Sekmedeki kayıt noktası kaybolur |
| D-05 | Görüşme sırasında mikrofonu değiştir | Kısa kesintiden sonra ses devam eder; "Aktif mikrofon" yeni cihazı gösterir |
| D-06 | Değiştirdikten sonra | Karşı taraf yeni cihazdan duyar, eskiden duymaz |
| D-07 | Mikrofon kapalıyken cihaz değiştir | Mikrofon açılmaz, izin penceresi çıkmaz |
| D-08 | Aktif USB mikrofonu çıkar | Mikrofon kapanır, hata gösterilir; laptop/webcam mikrofonu açılmaz; geri takınca da kapalı kalır |
| D-09 | USB kulaklık ve monitör sesi arasında seçim | Listede görünür, seçilebilir |
| D-10 | "Hoparlörü test et" | Kısa ton seçilen fiziksel cihazdan duyulur |
| D-11 | Görüşme sırasında ses çıkışını değiştir | Konuşmalar yeni cihazdan gelir |
| D-12 | Birden fazla katılımcı varken | Herkesin sesi seçilen cihazdan gelir |
| D-13 | Bluetooth kulaklık bağlantısı kesilir | Hoparlör kapanır ve uyarı çıkar; konuşma laptop hoparlöründen çalmamalı (işletim sistemi kısa süre yönlendirebilir — gözlemini yaz) |
| D-14 | Hoparlör kapalıyken çıkış seç | Konuşmalar çalmaz |
| D-15 | Genel ses kaydırıcısı | Herkesin sesi değişir |
| D-16 | Bir kişinin ses kaydırıcısı | Sadece o kişi değişir |
| D-17 | Bir kişiyi "Sustur" | Sadece o kişi susar; diğerleri ve karşı taraf etkilenmez |
| D-18 | Gürültü bastırma / yankı engelleme / otomatik ses | Ayar yanındaki "(uygulandı)" bilgisi ve duyulan fark |
| D-19 | Yeni katılımcı gelince | Cihaz seçimlerin değişmez |
| D-20 | "Tercihlerimi hatırla" açıkken sayfayı yenile | Seçimler korunur |
| D-21 | Yenileme sonrası | Mikrofon ve hoparlör kapalı başlar |
| D-22 | Hatırlanan cihaz çıkarılmışken aç | "(şu an bağlı değil / bulunamadı)" görünür; başka cihaz açılmaz |
| D-23 | Ayarlar paneli kapanınca | Mikrofon testi biter |
| D-24 | Görüşmeden ayrılınca | Kayıt noktası yok, ses yok |
| D-25 | Windows Chrome ve Edge | D-01, D-05, D-10, D-11 her ikisinde çalışır |
| D-26 | Aynı tarayıcıda ikinci sekmede PsstAmigo aç | "Başka bir sekmede açık" çıkar; "Burada devam et" deyince eski sekme görüşmeden çıkar |

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
