/* eslint-disable */
import * as functions from "firebase-functions/v1";
import * as line from "@line/bot-sdk";
import { Client } from "@notionhq/client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";

// Firebase Admin SDK のみを使い、シンプルに初期化します
import * as admin from "firebase-admin";

// プロジェクトIDを直接指定して、迷子にならないようにします
if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: "shinrizemi-linebot"
    });
}

const db = admin.firestore();
// defaultデータベースを明示的に指定（NOT_FOUND対策）
db.settings({ databaseId: "default", ignoreUndefinedProperties: true });

// ★New! Googleカレンダー設定
const calendarKey = require("../calendar-key.json"); // 先ほど置いた秘密鍵を読み込む
const GOOGLE_CALENDAR_ID = "c7b5074ec62bd8c6efb51743195e1c7456f7a4c45053316cec023e13b70c5b9e@group.calendar.google.com";
const PROP_EVENT_GCAL_ID = "カレンダーID"; // 先ほどNotionに追加したプロパティ


// Google APIの初期化（ロボットのログイン処理）
const jwtClient = new google.auth.JWT({
    email: calendarKey.client_email,
    key: calendarKey.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar.events"]
});
const calendar = google.calendar({ version: "v3", auth: jwtClient });

// ▼▼▼ 設定エリア ▼▼▼
const LINE_CONFIG = {
    channelAccessToken: "uZegG27xx8nqZeqols88ebJt4zoYaSYv8/agPz4e3QLqYl0gX3F0lYhgwBoAZdrEM2S9m2SwEq5fGIQTgC8e2mV6Mj"+"xk2Tos47Zy7YA/B5uFJzd2QZpPqxGFReAKo3823lgGUbPb1PAZBN/zvSLMDQdB04t89/1O/w1cDnyilFU=",
    channelSecret: "cb26704abe34a65b"+"d1d4008d51ea43b7",
};

const NOTION_KEY = process.env.NOTION_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL_NAME = "gemini-2.0-flash";

const MEMBER_DB_ID = "281d37536ad78161903ce60d6afafe59";
const EVENT_DB_ID = "307d37536ad780f9a72cfb32808fefc9";          // ★新規追加！

// プロパティ名
const PROP_MEMBER_NAME = "名前";
const PROP_LINE_USER_ID = "LINE_USER_ID";
const PROP_MEMBER_TAGS = "興味・関心";
const PROP_MEMBER_INTRO = "ひとこと";
const PROP_EVENT_NAME = "イベント名";
const PROP_EVENT_DATE = "開催日";
const PROP_EVENT_CAT = "カテゴリ";
const PROP_EVENT_TAGS = "マッチングタグ";
const PROP_JOIN = "参加者";
const PROP_MAYBE = "迷い中";
const PROP_DECLINE = "不参加";
const PROP_DETAIL_TEXT = "詳細";
const PROP_MEMBER_UNI = "大学";
const PROP_MEMBER_FACULTY = "学部・学科";
const PROP_MEMBER_GRADE = "学年";
const PROP_MEMBER_ROLE = "役職";

const ADMIN_SEPARATOR = "🚧";
// ▲▲▲ 設定エリア終わり ▲▲▲

const lineClient = new line.Client(LINE_CONFIG);
const notion = new Client({ auth: NOTION_KEY }) as any;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ───────────────────────────────────────────
// 1. LINE Webhook
// ───────────────────────────────────────────
export const lineWebhook = functions.region("asia-northeast1").https.onRequest(async (req: any, res: any) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
    const events = req.body.events;
    if (!events || events.length === 0) { res.status(200).send("OK"); return; }
    try { await Promise.all(events.map(async (event: any) => handleEvent(event))); } catch (err) { console.error(err); }
    res.status(200).send("OK");
});

// ───────────────────────────────────────────
// 2. 定期実行: 新着イベント通知 (毎日21:00)
// ───────────────────────────────────────────
export const scheduledEventNotification = functions.region("asia-northeast1").pubsub
    .schedule("0 21 * * *").timeZone("Asia/Tokyo").onRun(async (context) => {
        console.log("🔔 定期通知バッチ開始");
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const todayStartISO = todayStart.toISOString();

        try {
            const newEvents = await notion.databases.query({
                database_id: EVENT_DB_ID,
                filter: { timestamp: "created_time", created_time: { on_or_after: todayStartISO } }
            });

            if (newEvents.results.length === 0) return null;

            const membersResponse = await notion.databases.query({ database_id: MEMBER_DB_ID, page_size: 100 });

            for (const member of membersResponse.results) {
                const lineIdProp = member.properties[PROP_LINE_USER_ID]?.rich_text;
                if (!lineIdProp || lineIdProp.length === 0) continue;
                const targetLineId = lineIdProp[0].text.content;

                const memberTags = member.properties[PROP_MEMBER_TAGS]?.multi_select?.map((t: any) => t.name) || [];
                if (memberTags.length === 0) continue;

                const matchedEvents: any[] = [];
                for (const event of newEvents.results) {
                    const title = event.properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
                    const displayDate = formatDate(event.properties[PROP_EVENT_DATE]?.date?.start);

                    const eventTags = event.properties[PROP_EVENT_TAGS]?.multi_select?.map((t: any) => t.name) || [];
                    const eventCat = event.properties[PROP_EVENT_CAT]?.select?.name || "";
                    if (eventCat) eventTags.push(eventCat);

                    const isMatch = memberTags.some((mTag: string) => eventTags.includes(mTag));

                    // ▼ マッチした場合、通知用のフルサイズカード（4つのボタン付き）を作成！
                    if (isMatch) {
                        matchedEvents.push({
                            type: "bubble", header: { type: "box", layout: "vertical", contents: [{ type: "text", text: `✨ マッチした新着イベント`, color: "#ff9f43", size: "xs", weight: "bold" }, { type: "text", text: title, weight: "bold", size: "lg", wrap: true }] },
                            body: { type: "box", layout: "vertical", contents: [{ type: "box", layout: "baseline", contents: [{ type: "text", text: "📅", flex: 1, size: "sm" }, { type: "text", text: displayDate, flex: 5, size: "sm", color: "#666666" }] }, { type: "box", layout: "baseline", margin: "md", contents: [{ type: "text", text: "🏷️", flex: 1, size: "sm" }, { type: "text", text: eventTags.join(", "), flex: 5, size: "sm", color: "#666666", wrap: true }] }] },
                            footer: { type: "box", layout: "vertical", spacing: "sm", contents: [{ type: "box", layout: "horizontal", spacing: "sm", contents: [{ type: "button", style: "primary", color: "#2ecc71", height: "sm", action: { type: "postback", label: "参加👍", data: `action=join&eventId=${event.id}`, displayText: `「${title}」に参加します！` } }, { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "迷い中🤔", data: `action=maybe&eventId=${event.id}`, displayText: `「${title}」迷い中です…` } }] }, { type: "box", layout: "horizontal", spacing: "sm", contents: [{ type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "不参加😢", data: `action=decline&eventId=${event.id}`, displayText: `「${title}」今回は不参加で…` } }, { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "参加者・詳細📄", data: `action=detail&eventId=${event.id}` } }] }] }
                        });
                    }
                }

                if (matchedEvents.length > 0) {
                    try {
                        const carouselContents = matchedEvents.slice(0, 10); // 上限10枚
                        await lineClient.pushMessage(targetLineId, {
                            type: "flex", altText: "✨ 興味タグにマッチする新着イベントのお知らせ",
                            contents: { type: "carousel", contents: carouselContents }
                        });
                    } catch (e) { console.error(`Push failed`, e); }
                }
            }
        } catch (e) { console.error("Batch Error:", e); }
        return null;
    });

// ───────────────────────────────────────────
// 3. 定期実行: 前日リマインド (毎日21:00)
// ───────────────────────────────────────────
export const scheduledEventReminder = functions.region("asia-northeast1").pubsub
    .schedule("0 21 * * *").timeZone("Asia/Tokyo").onRun(async (context) => {
        console.log("⏰ 前日リマインド開始");
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        const y = tomorrow.getFullYear();
        const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
        const d = String(tomorrow.getDate()).padStart(2, '0');
        const targetDateStr = `${y}-${m}-${d}`;

        try {
            const eventsResponse = await notion.databases.query({
                database_id: EVENT_DB_ID,
                filter: { property: PROP_EVENT_DATE, date: { equals: targetDateStr } }
            });
            if (eventsResponse.results.length === 0) return null;

            const membersResponse = await notion.databases.query({ database_id: MEMBER_DB_ID, page_size: 100 });
            const memberMap: { [key: string]: string } = {};
            membersResponse.results.forEach((member: any) => {
                const lineId = member.properties[PROP_LINE_USER_ID]?.rich_text?.[0]?.text?.content;
                if (lineId) memberMap[member.id] = lineId;
            });

            for (const event of eventsResponse.results) {
                const title = (event as any).properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
                const startTime = (event as any).properties[PROP_EVENT_DATE]?.date?.start?.split("T")[1] || "時間未定";
                const participants = (event as any).properties[PROP_JOIN]?.relation || [];
                if (participants.length === 0) continue;

                for (const p of participants) {
                    const targetLineId = memberMap[p.id];
                    if (targetLineId) {
                        try {
                            await lineClient.pushMessage(targetLineId, {
                                type: "flex", altText: `⏰ リマインド: 明日は「${title}」です！`,
                                contents: {
                                    type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#3498db", contents: [{ type: "text", text: "⏰ イベント前日リマインド", weight: "bold", color: "#ffffff" }] },
                                    body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "明日は参加予定のイベントがあります！", size: "xs", color: "#666666" }, { type: "text", text: title, weight: "bold", size: "xl", wrap: true }, { type: "box", layout: "baseline", margin: "md", contents: [{ type: "text", text: "🕒", flex: 1, size: "sm" }, { type: "text", text: startTime, flex: 5, size: "sm" }] }] },
                                    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "詳細を確認", data: `action=detail&eventId=${event.id}` } }] }
                                }
                            });
                        } catch (e) { }
                    }
                }
            }
        } catch (e) { console.error("Reminder Error:", e); }
        return null;
    });

// ───────────────────────────────────────────
// 4. Googleカレンダーからの更新通知を受け取るWebhook
// ───────────────────────────────────────────
export const googleCalendarWebhook = functions.region("asia-northeast1").https.onRequest(async (req: any, res: any) => {
    const resourceState = req.headers['x-goog-resource-state'];
    const channelId = req.headers['x-goog-channel-id'];

    // ⚠️ 【超重要】Googleへ「通知を受け取った」とすぐに返す（これがないとエラーになります）
    res.status(200).send('OK');

    if (resourceState === 'sync') {
        console.log(`監視設定の確認完了 Channel ID: ${channelId}`);
        return;
    }

    if (resourceState === 'exists') {
        console.log(`カレンダーに更新あり！自動同期を開始 Channel ID: ${channelId}`);
        try {
            // 1. 「ここ5分以内」に変更があった予定だけをGoogleカレンダーから取得する
            const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            const response = await calendar.events.list({
                calendarId: GOOGLE_CALENDAR_ID,
                updatedMin: fiveMinsAgo,
                singleEvents: true,
                showDeleted: true, // 削除された予定も検知するため
            });

            const events = response.data.items || [];

            // 2. 取得した予定を1つずつNotionに反映させる
            for (const event of events) {
                const gcalId = event.id;
                if (!gcalId) continue;

                // すでにNotionに同じIDの予定が存在するかチェック
                const notionSearch = await notion.databases.query({
                    database_id: EVENT_DB_ID,
                    filter: { property: PROP_EVENT_GCAL_ID, rich_text: { equals: gcalId } }
                });
                const existingPage = notionSearch.results[0];

                // ▼ パターン①：予定がGoogleカレンダーで「削除」された場合
                if (event.status === "cancelled") {
                    if (existingPage) {
                        await notion.pages.update({ page_id: existingPage.id, archived: true }); // Notion側も削除（アーカイブ）
                        console.log(`Notionの予定を削除しました: ${gcalId}`);
                    }
                    continue;
                }

                // ▼ パターン②：予定が「追加・変更」された場合
                const title = event.summary || "無題の予定";

                // 日付データの整形（時間指定か、終日イベントかで分ける）
                let dateProp: any = {};
                if (event.start?.dateTime) {
                    dateProp.start = event.start.dateTime; // 時間あり
                    if (event.end?.dateTime) dateProp.end = event.end.dateTime;
                } else if (event.start?.date) {
                    dateProp.start = event.start.date;     // 終日イベント
                }

                // Notionに書き込むデータ
                const properties = {
                    [PROP_EVENT_NAME]: { title: [{ text: { content: title } }] },
                    [PROP_EVENT_DATE]: { date: dateProp },
                    [PROP_EVENT_GCAL_ID]: { rich_text: [{ text: { content: gcalId } }] }
                };

                if (existingPage) {
                    // すでにある場合は「上書き更新」
                    await notion.pages.update({ page_id: existingPage.id, properties: properties });
                    console.log(`Notionの予定を更新しました: ${title}`);
                } else {
                    // ない場合は「新規作成」
                    await notion.pages.create({
                        parent: { database_id: EVENT_DB_ID },
                        properties: properties
                    });
                    console.log(`Notionに予定を新規作成しました: ${title}`);
                }
            }
            console.log('バックグラウンド自動同期が完了しました');
        } catch (error) {
            console.error('自動同期エラー:', error);
        }
    }
});

// ───────────────────────────────────────────
// メインハンドラー
// ───────────────────────────────────────────
async function handleEvent(event: any) {
    const userId = event.source.userId;
    const replyToken = event.replyToken;

    if (event.type === "postback") {
        const data = new URLSearchParams(event.postback.data);
        const action = data.get("action");
        const eventId = data.get("eventId");
        const category = data.get("category");
        const tag = data.get("tag");

        if (eventId) {
            if (action === "join") await handleStatusUpdate(replyToken, userId, eventId, PROP_JOIN, "参加");
            if (action === "maybe") await handleStatusUpdate(replyToken, userId, eventId, PROP_MAYBE, "迷い中");
            if (action === "decline") await handleStatusUpdate(replyToken, userId, eventId, PROP_DECLINE, "不参加");
            if (action === "detail") await handleShowDetail(replyToken, eventId);
        }
        if (action === "search_cat" && category) await handleCategorySearch(replyToken, category);
        if (action === "about_cat" && category) await reply(replyToken, `🙇‍♂️ 「${category}」の紹介ページは現在準備中です！`);
        if (action === "create_account") await handleCreateAccount(replyToken, userId);
        if (action === "link_manual") await reply(replyToken, "連携したい名前を「連携 武田」のように入力して送信してください！");

        if (action === "edit_tags") await handleTagMenu(replyToken, userId);
        if (action === "toggle_tag" && tag) await handleToggleTag(replyToken, userId, tag);

        if (action === "edit_intro") await reply(replyToken, "💬 ひとことを編集します。\n\n「ひとこと （スペース） 〇〇」のように入力して送信してください。（※最大40文字程度がおすすめです）"); return null;
    }

    if (event.type !== "message" || event.message.type !== "text") return null;
    const text = event.message.text.trim();

    if (text === "イベント" || text === "予定") { await handleListEvents(replyToken); return null; }
    if (text === "参加予定") { await handleMySchedule(replyToken, userId, "future"); return null; }
    if (text === "履歴") { await handleMySchedule(replyToken, userId, "past"); return null; }
    if (text === "メニュー" || text === "探す" || text === "部活") { await handleSearchMenu(replyToken); return null; }
    if (text === "個人設定" || text === "マイページ" || text === "設定") { await handlePersonalMenu(replyToken, userId); return null; }

    if (text === "タグ通知" || text === "新着テスト") { await handleTagNotificationManual(replyToken, userId); return null; }
    if (text === "タグ同期") { await handleSyncTags(replyToken); return null; }
    if (text === "直近のイベント") { await handleRecentEvents(event.replyToken); return; }

    // ★New! カレンダー同期用の隠しコマンド
    if (text === "カレンダー同期") { await handleSyncCalendar(replyToken); return null; }

    // ▼▼ ここに追加 ▼▼
    if (text === "監視スタート") { await handleSetupWatch(replyToken); return null; }
    // ★New! LIFFからデータを受け取った時の処理を追加

    if (text.startsWith("【プロフ更新】")) {
        await handleProfileUpdate(replyToken, userId, text);
        return null;
    }

    if (text.startsWith("ひとこと ") || text.startsWith("ひとこと　")) {
        const introText = text.replace(/^ひとこと[\s　]+/, "");
        await handleUpdateIntro(replyToken, userId, introText);
        return null;
    }
    if (text.startsWith("連携")) {
        const name = text.replace(/　/g, " ").split(" ")[1];
        if (!name) { await reply(replyToken, "⚠️ 名前を入力してください（例：連携 武田）"); return null; }
        await handleLinkUser(replyToken, userId, name);
        return null;
    }

    if (text.length > 0) { await handleNotionSearchAI(replyToken, userId, text); return null; }
    return null;
}

// ───────────────────────────────────────────
// イベント・検索ロジック
// ───────────────────────────────────────────
async function handleListEvents(replyToken: string) {
    const today = new Date().toISOString().split('T')[0];
    await queryAndReplyEvents(replyToken, { and: [{ property: PROP_EVENT_DATE, date: { on_or_after: today } }] }, "📅 今後のイベント一覧", "ascending");
}

async function handleMySchedule(replyToken: string, userId: string, type: "future" | "past") {
    const memberPage = await getMemberPage(userId);
    if (!memberPage) { await reply(replyToken, "⚠️ 先に「連携 [名前]」をしてください！"); return; }
    const memberId = memberPage.id;
    const memberName = memberPage.properties[PROP_MEMBER_NAME]?.title[0]?.plain_text;
    const today = new Date().toISOString().split('T')[0];
    const dateFilter = type === "future" ? { on_or_after: today } : { before: today };
    const titleText = type === "future" ? `🙋‍♂️ ${memberName}さんの参加予定` : `🕰️ ${memberName}さんの活動履歴`;
    const direction = type === "past" ? "descending" : "ascending";
    await queryAndReplyEvents(replyToken, { and: [{ property: PROP_JOIN, relation: { contains: memberId } }, { property: PROP_EVENT_DATE, date: dateFilter }] }, titleText, direction);
}

async function handleCategorySearch(replyToken: string, category: string) {
    await queryAndReplyEvents(replyToken, { and: [{ property: PROP_EVENT_CAT, multi_select: { contains: category } }] }, `🔍 「${category}」の直近5回の活動`, "descending", category);
}

async function queryAndReplyEvents(replyToken: string, filter: any, altText: string, sortDirection: "ascending" | "descending" = "ascending", categoryName: string | null = null) {
    try {
        const response = await notion.databases.query({ database_id: EVENT_DB_ID, sorts: [{ property: PROP_EVENT_DATE, direction: sortDirection }], filter: filter, page_size: 5 });
        if (response.results.length === 0) { await reply(replyToken, `${altText}\n\nデータが見つかりませんでした。`); return; }
        const bubbles = response.results.map((page: any) => {
            const title = page.properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
            const displayDate = formatDate(page.properties[PROP_EVENT_DATE]?.date?.start);
            const cat = page.properties[PROP_EVENT_CAT]?.select?.name || page.properties[PROP_EVENT_CAT]?.multi_select?.[0]?.name || "その他";
            return {
                type: "bubble", header: { type: "box", layout: "vertical", contents: [{ type: "text", text: cat, color: "#aaaaaa", size: "xs" }, { type: "text", text: title, weight: "bold", size: "lg", wrap: true }] },
                body: { type: "box", layout: "vertical", contents: [{ type: "box", layout: "baseline", contents: [{ type: "text", text: "📅", flex: 1, size: "sm" }, { type: "text", text: displayDate, flex: 5, size: "sm", color: "#666666" }] }, { type: "box", layout: "baseline", margin: "md", contents: [{ type: "text", text: "👥", flex: 1, size: "sm" }, { type: "text", text: `参加: ${page.properties[PROP_JOIN]?.relation?.length || 0}名`, flex: 5, size: "sm", color: "#666666" }] }] },
                footer: { type: "box", layout: "vertical", spacing: "sm", contents: [{ type: "box", layout: "horizontal", spacing: "sm", contents: [{ type: "button", style: "primary", color: "#2ecc71", height: "sm", action: { type: "postback", label: "参加👍", data: `action=join&eventId=${page.id}`, displayText: `「${title}」に参加します！` } }, { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "迷い中🤔", data: `action=maybe&eventId=${page.id}`, displayText: `「${title}」迷い中です…` } }] }, { type: "box", layout: "horizontal", spacing: "sm", contents: [{ type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "不参加😢", data: `action=decline&eventId=${page.id}`, displayText: `「${title}」今回は不参加で…` } }, { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "参加者・詳細📄", data: `action=detail&eventId=${page.id}` } }] }] }
            };
        });
        const replyMessages: any[] = [];
        if (categoryName) { replyMessages.push({ type: "flex", altText: `${categoryName}について`, contents: { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: `📖 ${categoryName}とは？`, weight: "bold", size: "sm", color: "#2c3e50" }, { type: "text", text: "活動の詳細や紹介はこちら", size: "xxs", color: "#aaaaaa", margin: "xs" }] }, footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "紹介を見る（準備中）", data: `action=about_cat&category=${categoryName}` } }] } } }); }
        replyMessages.push({ type: "flex", altText: altText, contents: { type: "carousel", contents: bubbles } });
        await lineClient.replyMessage(replyToken, replyMessages);
    } catch (e: any) { console.error(e); await reply(replyToken, `❌ エラー: ${e.message}`); }
}

async function handleStatusUpdate(replyToken: string, userId: string, eventId: string, targetProp: string, statusLabel: string) {
    try {
        const memberPage = await getMemberPage(userId);
        if (!memberPage) { await reply(replyToken, "先に連携してください！"); return; }
        const memberPageId = memberPage.id;
        const memberName = memberPage.properties[PROP_MEMBER_NAME]?.title[0]?.plain_text;
        const eventPage: any = await notion.pages.retrieve({ page_id: eventId });
        const eventTitle = eventPage.properties[PROP_EVENT_NAME]?.title[0]?.plain_text;
        let joinList = eventPage.properties[PROP_JOIN]?.relation || [];
        let maybeList = eventPage.properties[PROP_MAYBE]?.relation || [];
        let declineList = eventPage.properties[PROP_DECLINE]?.relation || [];
        joinList = joinList.filter((p: any) => p.id !== memberPageId);
        maybeList = maybeList.filter((p: any) => p.id !== memberPageId);
        declineList = declineList.filter((p: any) => p.id !== memberPageId);
        if (targetProp === PROP_JOIN) joinList.push({ id: memberPageId });
        if (targetProp === PROP_MAYBE) maybeList.push({ id: memberPageId });
        if (targetProp === PROP_DECLINE) declineList.push({ id: memberPageId });
        await notion.pages.update({ page_id: eventId, properties: { [PROP_JOIN]: { relation: joinList }, [PROP_MAYBE]: { relation: maybeList }, [PROP_DECLINE]: { relation: declineList } } });
        await reply(replyToken, `🆗 ${memberName}さんの「${eventTitle}」を【${statusLabel}】に変更しました！`);
    } catch (e: any) { console.error(e); }
}

async function handleShowDetail(replyToken: string, eventId: string) {
    try {
        const page: any = await notion.pages.retrieve({ page_id: eventId });
        
        // 参加・迷い中・不参加のメンバー名前を取得する便利関数（最大10名まで）
        const fetchNames = async (relationIds: any[]) => {
            if (!relationIds || relationIds.length === 0) return "まだいません";
            const limit = Math.min(relationIds.length, 10);
            const names = [];
            for (let i = 0; i < limit; i++) { 
                const m: any = await notion.pages.retrieve({ page_id: relationIds[i].id }); 
                names.push(m.properties[PROP_MEMBER_NAME]?.title[0]?.plain_text || "不明"); 
            }
            let res = names.join("、");
            if (relationIds.length > limit) res += `、他${relationIds.length - limit}名`;
            return res;
        };

        const joinIds = page.properties[PROP_JOIN]?.relation || [];
        const maybeIds = page.properties[PROP_MAYBE]?.relation || [];
        const declineIds = page.properties[PROP_DECLINE]?.relation || [];

        // 並行して3つのステータスの名前リストを取得して高速化
        const [joinNames, maybeNames, declineNames] = await Promise.all([
            fetchNames(joinIds), fetchNames(maybeIds), fetchNames(declineIds)
        ]);

        const blocks = await notion.blocks.children.list({ block_id: eventId });
        let contentText = "";
        
        for (const block of blocks.results as any[]) {
            let blockText = "";
            if (block.type === "paragraph" && block.paragraph.rich_text.length > 0) blockText = block.paragraph.rich_text.map((t: any) => t.plain_text).join("");
            else if (block.type.startsWith("heading")) blockText = "【" + block[block.type].rich_text.map((t: any) => t.plain_text).join("") + "】";
            else if (block.type.endsWith("list_item")) blockText = "・" + block[block.type].rich_text.map((t: any) => t.plain_text).join("");

            // 🌟 Notion側の「🚧」が出現したら、それ以降（運営用）は読み込まないでストップ！
            if (blockText.includes(ADMIN_SEPARATOR)) break;

            if (blockText) contentText += blockText + "\n";
            if (block.type === "paragraph") contentText += "\n";
        }
        
        if (!contentText.trim()) contentText = page.properties[PROP_DETAIL_TEXT]?.rich_text[0]?.plain_text || "詳細情報はありません。";
        if (contentText.length > 700) contentText = contentText.substring(0, 700) + "\n(省略)";

        // ▼ トークルームに詳細メッセージを送信！
        await reply(replyToken, `🙋 参加 (${joinIds.length}名)\n${joinNames}\n\n🤔 迷い中 (${maybeIds.length}名)\n${maybeNames}\n\n🙅 不参加 (${declineIds.length}名)\n${declineNames}\n\n──────────\n📄 イベント詳細\n\n${contentText.trim()}`);
        
    } catch (e: any) { console.error(e); await reply(replyToken, `❌ エラー: ${e.message}`); }
}

// ───────────────────────────────────────────
// タグ・個人設定ロジック
// ───────────────────────────────────────────
async function handleTagMenu(replyToken: string, userId: string) { await replyTagMenuCarousel(replyToken, userId); }

async function handleToggleTag(replyToken: string, userId: string, tag: string) {
    const memberPage = await getMemberPage(userId);
    if (!memberPage) return;
    let currentTags = memberPage.properties[PROP_MEMBER_TAGS]?.multi_select?.map((t: any) => t.name) || [];
    let message = "";
    if (currentTags.includes(tag)) {
        currentTags = currentTags.filter((t: string) => t !== tag);
        message = `🗑️ 「${tag}」を外しました`;
    } else {
        currentTags.push(tag);
        message = `✨ 「${tag}」を追加しました`;
    }
    await notion.pages.update({ page_id: memberPage.id, properties: { [PROP_MEMBER_TAGS]: { multi_select: currentTags.map((t: string) => ({ name: t })) } } });
    await reply(replyToken, message);
}

async function replyTagMenuCarousel(replyToken: string, userId: string) {
    const memberPage = await getMemberPage(userId);
    if (!memberPage) { await reply(replyToken, "先に連携してください！"); return; }

    let allTags = await getOptionsFromNotion(MEMBER_DB_ID, PROP_MEMBER_TAGS);
    if (allTags.length === 0) allTags = ["タグ未設定"];

    const currentTags = memberPage.properties[PROP_MEMBER_TAGS]?.multi_select?.map((t: any) => t.name) || [];

    // ★ 変更点1：1つのカードに入れるタグを「6個」に減らす（縦長になりすぎないようにするため）
    const TAGS_PER_BUBBLE = 7;
    const bubbles: any[] = [];

    for (let i = 0; i < allTags.length; i += TAGS_PER_BUBBLE) {
        const chunk = allTags.slice(i, i + TAGS_PER_BUBBLE);

        // ★ 変更点2：1列にするので、ボタンをそのまま縦に並べる
        const buttons = chunk.map(tag => {
            const isSelected = currentTags.includes(tag);
            return {
                type: "button" as const,
                style: (isSelected ? "primary" : "secondary") as "primary" | "secondary",
                color: isSelected ? "#2ecc71" : "#ecf0f1",
                height: "sm" as const,
                margin: "xs" as const,
                action: {
                    type: "postback" as const,
                    label: `${isSelected ? "✅" : "➕"} ${tag}`,
                    data: `action=toggle_tag&tag=${tag}`
                }
            };
        });

        const headerContents: any[] = [];
        if (i === 0) {
            headerContents.push({ type: "text", text: "🏷️ 興味タグ設定", weight: "bold", size: "lg", color: "#2c3e50" });
            headerContents.push({ type: "text", text: "横にスワイプして探せます 👉", size: "xs", color: "#aaaaaa", margin: "sm" });
        } else {
            headerContents.push({ type: "text", text: "🏷️ 続き", weight: "bold", size: "md", color: "#aaaaaa" });
        }

        bubbles.push({
            type: "bubble",
            size: "mega", // ★ 変更点3：1列で横幅を広く使えるサイズ（mega）に設定
            header: { type: "box", layout: "vertical", contents: headerContents },
            body: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: buttons // ここでボタンをそのまま縦に並べる
            },
            footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "link", action: { type: "message", label: "完了（閉じる）", text: "個人設定" } }] }
        });
    }

    await lineClient.replyMessage(replyToken, { type: "flex", altText: "興味タグ設定メニュー", contents: { type: "carousel", contents: bubbles } });
}


// ───────────────────────────────────────────
// 👤 マイページ ＆ プロフィール更新
// ───────────────────────────────────────────
async function handleProfileUpdate(replyToken: string, userId: string, text: string) {
    const lines = text.split('\n');
    let name = "", uni = "", faculty = "", grade = "", selfIntro = "", tagsText = "";
    let isIntro = false;

    // テキストから各項目を抽出（★興味タグを追加）
    for (const line of lines) {
        if (line.startsWith("名前:")) { name = line.replace("名前:", "").trim(); continue; }
        if (line.startsWith("大学:")) { uni = line.replace("大学:", "").trim(); continue; }
        if (line.startsWith("学部:")) { faculty = line.replace("学部:", "").trim(); continue; }
        if (line.startsWith("学年:")) { grade = line.replace("学年:", "").trim(); continue; }
        if (line.startsWith("興味タグ:")) { tagsText = line.replace("興味タグ:", "").trim(); continue; }
        if (line.startsWith("自己紹介:")) { isIntro = true; selfIntro += line.replace("自己紹介:", "") + "\n"; continue; }
        if (isIntro) { selfIntro += line + "\n"; }
    }
    selfIntro = selfIntro.trim();

    if (!name) { await reply(replyToken, "⚠️ 名前の取得に失敗しました。"); return; }

    try {
        let memberPage = await getMemberPage(userId);

        if (!memberPage) {
            const nameSearch = await notion.databases.query({
                database_id: MEMBER_DB_ID,
                filter: { property: PROP_MEMBER_NAME, title: { equals: name } }
            });
            if (nameSearch.results.length > 0) memberPage = nameSearch.results[0];
        }

        const profile = await lineClient.getProfile(userId);
        const iconUrl = profile.pictureUrl;

        let roles: string[] = []; 
        let currentIntro = "";
        let currentTags: string[] = [];
        if (memberPage) {
            roles = memberPage.properties[PROP_MEMBER_ROLE]?.multi_select?.map((t:any)=>t.name) || [];
            if (roles.length === 0) roles = ["一般メンバー"];
            currentIntro = memberPage.properties[PROP_MEMBER_INTRO]?.rich_text[0]?.plain_text || "";
            currentTags = memberPage.properties[PROP_MEMBER_TAGS]?.multi_select?.map((t:any)=>t.name) || [];
        }

        // ★ 新しい興味タグの配列を作成
        let newTags = currentTags;
        if (text.includes("興味タグ:")) {
            newTags = tagsText.split(",").map(t => t.trim()).filter(t => t !== "");
        }

        const propertiesToUpdate: any = {
            [PROP_MEMBER_NAME]: { title: [{ text: { content: name } }] },
            [PROP_MEMBER_UNI]: { rich_text: [{ text: { content: uni } }] },
            [PROP_MEMBER_FACULTY]: { rich_text: [{ text: { content: faculty } }] },
            [PROP_MEMBER_GRADE]: { select: { name: grade } },
            [PROP_LINE_USER_ID]: { rich_text: [{ text: { content: userId } }] },
            [PROP_MEMBER_TAGS]: { multi_select: newTags.map(t => ({ name: t })) } // ★タグを更新
        };

        const updateParams: any = { properties: propertiesToUpdate };
        if (iconUrl) { updateParams.icon = { type: "external", external: { url: iconUrl + "#.jpg" } }; }

        let targetPageId = "";

        if (memberPage) {
            updateParams.page_id = memberPage.id;
            await notion.pages.update(updateParams);
            targetPageId = memberPage.id;
        } else {
            updateParams.parent = { database_id: MEMBER_DB_ID };
            const newPage = await notion.pages.create(updateParams);
            targetPageId = newPage.id;
        }

        if (selfIntro) {
            const blocksResponse = await notion.blocks.children.list({ block_id: targetPageId });
            const blocks = blocksResponse.results;
            
            let introBlockId = null;

            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                if (block.type === "heading_3" && block.heading_3.rich_text.some((t:any) => t.plain_text.includes("📝 自己紹介"))) {
                    if (blocks[i+1] && blocks[i+1].type === "paragraph") {
                        introBlockId = blocks[i+1].id;
                    }
                    break;
                }
            }

            if (introBlockId) {
                await notion.blocks.update({
                    block_id: introBlockId,
                    paragraph: { rich_text: [{ type: "text", text: { content: selfIntro } }] }
                });
            } else {
                await notion.blocks.children.append({
                    block_id: targetPageId,
                    children: [
                        { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📝 自己紹介" } }] } },
                        { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: selfIntro } }] } }
                    ]
                });
            }
        }

        await db.collection("users").doc(userId).set({
            profile: { 
                name: name, uni: uni, faculty: faculty, grade: grade, 
                selfIntro: selfIntro, intro: currentIntro, roles: roles, 
                iconUrl: iconUrl, tags: newTags // ★Firestoreにも新しいタグを保存
            }
        }, { merge: true });

        await reply(replyToken, `🎉 プロフィールと興味タグを更新しました！\nあなたに合った情報をお届けします👀`);

    } catch (e: any) {
        console.error("Profile Update Error:", e);
        await reply(replyToken, "❌ エラー: プロフィールの保存に失敗しました。");
    }
}

async function handlePersonalMenu(replyToken: string, userId: string) {
    const memberPage = await getMemberPage(userId);
    const LIFF_URL = "https://liff.line.me/2009176797-qGY6VB64";

    if (memberPage) {
        const memberName = memberPage.properties[PROP_MEMBER_NAME]?.title[0]?.plain_text || "名無し";
        const currentTags = memberPage.properties[PROP_MEMBER_TAGS]?.multi_select?.map((t: any) => t.name).join(", ") || "未設定";
        const uni = memberPage.properties[PROP_MEMBER_UNI]?.rich_text[0]?.plain_text || "未設定";
        const faculty = memberPage.properties[PROP_MEMBER_FACULTY]?.rich_text[0]?.plain_text || "未設定";
        const grade = memberPage.properties[PROP_MEMBER_GRADE]?.select?.name || "未設定";
        const role = memberPage.properties[PROP_MEMBER_ROLE]?.select?.name || "一般メンバー";

        // ★ひとこと（旧：自己紹介）
        let hitokoto = memberPage.properties[PROP_MEMBER_INTRO]?.rich_text[0]?.plain_text || "よろしくお願いします！";
        if (hitokoto.length > 50) hitokoto = hitokoto.substring(0, 50) + "...";

        await lineClient.replyMessage(replyToken, {
            type: "flex", altText: "マイページ",
            contents: {
                type: "bubble",
                header: {
                    type: "box", layout: "vertical", backgroundColor: "#2ecc71",
                    contents: [
                        { type: "text", text: "👤 マイページ", weight: "bold", color: "#ffffff", size: "lg" },
                        { type: "text", text: `${memberName} さん`, color: "#ffffff", size: "md", weight: "bold", margin: "sm" },
                        { type: "text", text: `🎖 役職: ${role}`, color: "#e8f8f5", size: "xs", margin: "xs" }
                    ]
                },
                body: {
                    type: "box", layout: "vertical", spacing: "md",
                    contents: [
                        { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "🎓", flex: 1, size: "sm" }, { type: "text", text: `${uni} ${grade}`, flex: 8, size: "sm", color: "#333333", wrap: true }] },
                        { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "📚", flex: 1, size: "sm" }, { type: "text", text: faculty, flex: 8, size: "sm", color: "#333333", wrap: true }] },
                        { type: "box", layout: "baseline", spacing: "sm", contents: [{ type: "text", text: "🏷️", flex: 1, size: "sm" }, { type: "text", text: currentTags, flex: 8, size: "sm", color: "#333333", wrap: true }] },
                        { type: "separator", margin: "md" },
                        { type: "text", text: "💬 今のひとこと:", size: "xs", color: "#aaaaaa" },
                        { type: "text", text: hitokoto, size: "sm", wrap: true, color: "#666666", weight: "bold" },
                        { type: "separator", margin: "md" },
                        { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "📝 基本情報を編集", uri: LIFF_URL } },
                        { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "🏷️ 興味タグを編集", data: "action=edit_tags" } },
                        // ★ボタン名を「ひとこと」に変更
                        { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "💬 ひとことを編集", data: "action=edit_intro" } }
                    ]
                }
            }
        });
    } else {
        // 未登録用UI（新バージョン）
        await lineClient.replyMessage(replyToken, {
            type: "flex", altText: "個人設定（未登録）",
            contents: {
                type: "bubble",
                header: { type: "box", layout: "vertical", backgroundColor: "#95a5a6", contents: [{ type: "text", text: "👤 マイページ", weight: "bold", color: "#ffffff", size: "lg" }, { type: "text", text: "未登録（ゲスト）", color: "#ffffff", size: "sm" }] },
                body: {
                    type: "box", layout: "vertical", spacing: "md",
                    contents: [
                        { type: "text", text: "⚠️ まずはプロフィールを登録・連携しましょう！", weight: "bold", size: "sm", color: "#e74c3c", align: "center", wrap: true },
                        { type: "text", text: "※すでにNotionに名前がある人も、下のボタンから自分の名前を入力すれば自動で紐付きます👍", size: "xs", color: "#666666", wrap: true },
                        { type: "button", style: "primary", color: "#06C755", action: { type: "uri", label: "📝 登録・連携する", uri: LIFF_URL } }
                    ]
                }
            }
        });
    }
}

async function handleUpdateIntro(replyToken: string, userId: string, introText: string) {
    const memberPage = await getMemberPage(userId);
    if (!memberPage) { await reply(replyToken, "先に連携してください！"); return; }
    try {
        await notion.pages.update({ page_id: memberPage.id, properties: { [PROP_MEMBER_INTRO]: { rich_text: [{ text: { content: introText } }] } } });
        
        // ★ ここを追加！Firestoreの「ひとこと」も更新する
        await db.collection("users").doc(userId).set({
            profile: { intro: introText }
        }, { merge: true });

        await reply(replyToken, `💬 ひとことを更新しました！\n\n「${introText}」`);
    } catch (e: any) {
        console.error(e);
        await reply(replyToken, "❌ 更新エラー");
    }
}

async function handleCreateAccount(replyToken: string, userId: string) {
    try {
        const profile = await lineClient.getProfile(userId);
        const displayName = profile.displayName;
        const existing = await getMemberPage(userId);
        if (existing) { await reply(replyToken, `⚠️ 既に登録済みです！`); return; }
        await notion.pages.create({ parent: { database_id: MEMBER_DB_ID }, properties: { [PROP_MEMBER_NAME]: { title: [{ text: { content: displayName } }] }, [PROP_LINE_USER_ID]: { rich_text: [{ text: { content: userId } }] }, [PROP_MEMBER_TAGS]: { multi_select: [] } } });
        await reply(replyToken, `🎉 登録完了！\n「${displayName}」として名簿を作成しました。\n\n「個人設定」から興味タグや自己紹介を追加してみましょう！`);
    } catch (e: any) { console.error(e); await reply(replyToken, "❌ エラー: Notionへの登録に失敗しました。"); }
}

// ───────────────────────────────────────────
// 管理・Sync・AIロジック
// ───────────────────────────────────────────
async function handleSyncTags(replyToken: string) {
    try {
        const memberDbInfo: any = await notion.databases.retrieve({ database_id: MEMBER_DB_ID });
        const memberTagsOptions = memberDbInfo.properties[PROP_MEMBER_TAGS]?.multi_select?.options;
        if (!memberTagsOptions) { await reply(replyToken, `❌ 部員名簿に「${PROP_MEMBER_TAGS}」プロパティが見つかりません。`); return; }
        
        await notion.databases.update({ database_id: EVENT_DB_ID, properties: { [PROP_EVENT_TAGS]: { multi_select: { options: memberTagsOptions } } } });
        
        const tagNames = memberTagsOptions.map((o: any) => o.name);

        // ★追加：Firestoreの「システム設定」にもタグ一覧を保存する！
        await db.collection("system").doc("metadata").set({
            tags: tagNames
        }, { merge: true });

        await reply(replyToken, `✅ タグ同期完了！\n\n[同期されたタグ]\n${tagNames.join(", ")}`);
    } catch (e: any) { 
        console.error("Sync Error:", e); 
        await reply(replyToken, `❌ エラー: イベント管理DBに「${PROP_EVENT_TAGS}」プロパティがあるか確認してください。`); 
    }
}

async function handleTagNotificationManual(replyToken: string, triggerUserId: string) {
    const today = new Date().toISOString().split('T')[0];
    const eventsResponse = await notion.databases.query({ database_id: EVENT_DB_ID, filter: { property: PROP_EVENT_DATE, date: { on_or_after: today } }, sorts: [{ property: PROP_EVENT_DATE, direction: "ascending" }], page_size: 10 });
    if (eventsResponse.results.length === 0) { await reply(replyToken, "📅 予定されているイベントがありません。"); return; }
    const membersResponse = await notion.databases.query({ database_id: MEMBER_DB_ID, page_size: 100 });
    await reply(replyToken, `🚀 手動通知テストを開始します...\n(対象イベント: ${eventsResponse.results.length}件)`);
    for (const member of membersResponse.results) {
        const lineIdProp = member.properties[PROP_LINE_USER_ID]?.rich_text;
        if (!lineIdProp || lineIdProp.length === 0) continue;
        const targetLineId = lineIdProp[0].text.content;
        const memberTags = member.properties[PROP_MEMBER_TAGS]?.multi_select?.map((t: any) => t.name) || [];
        if (memberTags.length === 0) continue;
        const matchedEvents = [];
        for (const event of eventsResponse.results) {
            const title = event.properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
            const date = formatDate(event.properties[PROP_EVENT_DATE]?.date?.start);
            const eventTags = event.properties[PROP_EVENT_TAGS]?.multi_select?.map((t: any) => t.name) || [];
            const eventCat = event.properties[PROP_EVENT_CAT]?.select?.name || "";
            if (eventCat) eventTags.push(eventCat);
            const isMatch = memberTags.some((mTag: string) => eventTags.includes(mTag));
            if (isMatch) { matchedEvents.push(`・${date} ${title} (${eventTags.join(", ")})`); }
        }
        if (matchedEvents.length > 0) { try { await lineClient.pushMessage(targetLineId, { type: "flex", altText: "🎯 おすすめイベント(手動テスト)", contents: { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#f1c40f", contents: [{ type: "text", text: "🎯 手動テスト通知", weight: "bold", color: "#ffffff" }] }, body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "興味タグに基づくイベントです", size: "xs", color: "#666666" }, { type: "separator" }, { type: "text", text: matchedEvents.join("\n"), wrap: true, size: "sm" }] } } }); } catch (e) { } }
    }
}

async function handleNotionSearchAI(replyToken: string, userId: string, queryText: string) {
    try {
        // １．Firestoreから過去の会話履歴を10件取得
        const historyRef = db.collection("users").doc(userId).collection("history");
        const snapshot = await historyRef.orderBy("createdAt", "desc").limit(10).get();
        const history = snapshot.docs.reverse().map(doc => doc.data());
        let historyContext = history.map(h => `ユーザー: ${h.user}\nAI: ${h.ai}`).join("\n");

        // ２．Notion検索キーワードをAIに抽出させる（既存の仕組み）
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        const keywordPrompt = `ユーザーの質問: "${queryText}"\nこの質問に関連する情報をNotionで検索するためのキーワードを1〜2個、スペース区切りで出力してください。余計な説明は不要です。`;
        const keywordResult = await model.generateContent(keywordPrompt);
        const keywords = keywordResult.response.text().trim();

        // ３．Notionデータベースを検索して contextText を作成
        const notionResponse = await notion.databases.query({
            database_id: EVENT_DB_ID,
            filter: {
                or: [
                    { property: PROP_EVENT_NAME, title: { contains: keywords.split(" ")[0] } },
                ],
            },
            page_size: 5
        });

        const contextText = notionResponse.results.length > 0
            ? notionResponse.results.map((page: any) => {
                const title = page.properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
                return `・${title}`;
            }).join("\n")
            : "関連するゼミの予定は見つかりませんでした。";

        // ３．５ ユーザーの診断データをFirestoreから取得する
        const userDocRef = db.collection("users").doc(userId);
        const userDocSnap = await userDocRef.get();
        const userData = userDocSnap.exists ? userDocSnap.data() : null;

        // ✅ Admin SDKは自動で型を変換するので、.stringValue は不要！
        const motivationData = userData?.motivationResult || "未診断";
        const chronoData = userData?.chronoResult || "未診断";
        const coffeeData = userData?.coffeeResult || "未診断";

        // ★ 満点を自動計算してAIに教える
// ▼ index.ts の変更部分 ▼
        // ★ 満点を自動計算してAIに教える
        let bigfiveData = "未診断";
        if (userData?.bigFiveScores) {
            const s = JSON.parse(userData.bigFiveScores);
            
            // ★ 新しい構造（domainScores）に対応させる
            if (s.domainScores) {
                bigfiveData = `外向性:${s.domainScores.extraversion}, 協調性:${s.domainScores.agreeableness}, 誠実性:${s.domainScores.conscientiousness}, 神経症的傾向:${s.domainScores.neuroticism}, 開放性:${s.domainScores.openness} (※各120点満点)\n詳細ファセット:${JSON.stringify(s.facetScores)}`;
            } else {
                // 古いデータ（簡易版など）への対応
                bigfiveData = `外向性:${s.extraversion}, 協調性:${s.agreeableness}, 誠実性:${s.conscientiousness}, 神経症的傾向:${s.neuroticism}, 開放性:${s.openness}`;
            }
        } else if (userData?.bigFiveResult) {
            bigfiveData = userData.bigFiveResult;
        }

        // ４．「北大心理ゼミのAI先輩」プロンプトを適用 ✨
        // ... (以下はそのまま)
        const systemPrompt = `
        あなたは北海道大学「心理ゼミ」の頼れる先輩メンター（AIアドバイザー）です。
        以下の【ユーザーの診断データ】と【過去の会話】を踏まえ、論理的かつ親身なアドバイスを行ってください。

        【会話・フォーマットの厳守ルール】
        １．キャラクターとトーン（重要）
        ・知的で落ち着いた「堅すぎない敬語（〜ですね、〜でしょうか）」を使用してください。
        ・「スゴイですね！」「やっぱり！」といった過剰なテンションや、絵文字の連続使用は避けてください。落ち着いた頼れる先輩のトーンを保ってください。
        ・Markdown記法（**太字** や # 見出しなど）はLINEで表示が崩れるため【絶対に使用禁止】です。強調したい場合もマークダウンは使わないでください。

        ２．「質問攻め（ループ）」の禁止（超重要）
        ・相手の話に共感して質問を投げるのは1回までです。「〜ということありませんか？」と何度も推測の質問を繰り返し続けるのは絶対にやめてください。
        ・ユーザーが「どう対策すればいい？」「どうすればいい？」と【解決策】を求めてきたら、質問をやめ、具体的なアドバイスや提案をするフェーズに切り替えてください。

        ３．診断データの明示とプロファイリング
        ・アドバイスの際は「診断で『経験への開放性』が高く出ていたので〜」など、根拠となる診断名を自然に織り交ぜてください。
        ・ユーザーの悩みに直面した際、複数のデータを組み合わせて「なぜその悩みが起きているか」を論理的に解説してあげてください。

        ４．解決策とコミュニティ（ゼミ）への接続
        ・ユーザーの課題が明確になったら、具体的な解決アクションを提案し、自然な流れで「ゼミのイベント」「Notionのコラム」「他のゼミ生」を紹介して、心理ゼミというコミュニティへ誘導してください。

        【ユーザーの診断データ】
        ・やる気８タイプ: ${motivationData}
        ・Big Five: ${bigfiveData}
        ・クロノタイプ: ${chronoData}
        ・コーヒー性格: ${coffeeData}

        【Notionのイベント・コラム情報】
        ${contextText}

        【過去の会話】
        ${historyContext}

        【ユーザーからの最新のメッセージ】
        "${queryText}"

        上記ルールに従い、1回の返信は20〜300文字程度の短文で、マークダウンを一切使わずに返信してください。
        `;

        // ５．AI回答の生成
        const result = await model.generateContent(systemPrompt);
        const aiResponse = result.response.text();

        // ６．システムコマンド以外ならFirestoreに保存（記憶）💾
        const SYSTEM_COMMANDS = ["イベント", "予定", "履歴", "メニュー", "探す", "設定", "連携", "同期", "監視"];
        const isSystemCommand = SYSTEM_COMMANDS.some(cmd => queryText.includes(cmd));
        if (!isSystemCommand) {
            await historyRef.add({
                user: queryText,
                ai: aiResponse,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // ７．心理テストの結果（キーワード等）が含まれている場合、最新結果として保存
        if (queryText.includes("診断結果")) {
            await db.collection("users").doc(userId).set({
                latestResult: aiResponse, // AIが要約した解説を保存
                lastTestedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        await reply(replyToken, aiResponse);
    } catch (e: any) {
        console.error(e);
        await reply(replyToken, "🤖 すみません、少し考え込んでしまいました。");
    }
}

// ───────────────────────────────────────────
// 共通ヘルパー関数
// ───────────────────────────────────────────
async function getOptionsFromNotion(databaseId: string, propertyName: string): Promise<string[]> {
    try {
        const response = await notion.databases.retrieve({ database_id: databaseId });
        const prop: any = response.properties[propertyName];
        if (!prop) return [];
        if (prop.type === "select") return prop.select.options.map((o: any) => o.name);
        else if (prop.type === "multi_select") return prop.multi_select.options.map((o: any) => o.name);
        return [];
    } catch (e) { console.error("Failed to fetch options:", e); return []; }
}

async function getMemberPage(userId: string) {
    const response = await notion.databases.query({ database_id: MEMBER_DB_ID, filter: { property: PROP_LINE_USER_ID, rich_text: { equals: userId } } });
    return response.results.length > 0 ? response.results[0] : null;
}

async function handleLinkUser(replyToken: string, userId: string, name: string) {
    try {
        const response = await notion.databases.query({ database_id: MEMBER_DB_ID, filter: { property: PROP_MEMBER_NAME, title: { equals: name } } });
        if (response.results.length === 0) { await reply(replyToken, "見つかりません"); return; }
        await notion.pages.update({ page_id: response.results[0].id, properties: { [PROP_LINE_USER_ID]: { rich_text: [{ text: { content: userId } }] } } });
        await reply(replyToken, "連携しました");
    } catch (e) { return; }
}

async function handleSearchMenu(replyToken: string) {
    let categories = await getOptionsFromNotion(EVENT_DB_ID, PROP_EVENT_CAT);
    if (categories.length === 0) categories = ["その他"];
    const buttons = categories.slice(0, 30).map(cat => ({
        type: "button" as const, style: "secondary" as const, height: "sm" as const, margin: "sm" as const,
        action: { type: "postback" as const, label: cat.substring(0, 40), data: `action=search_cat&category=${cat}` }
    }));
    await lineClient.replyMessage(replyToken, {
        type: "flex", altText: "部活・PJ検索メニュー",
        contents: { type: "bubble", header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔍 部活・PJを探す", weight: "bold", size: "xl", color: "#2c3e50" }] }, body: { type: "box", layout: "vertical", contents: buttons } }
    });
}

const reply = (token: string, text: string) => { return lineClient.replyMessage(token, { type: "text", text: text }); };

function formatDate(isoString: string) {
    if (!isoString) return "未定";
    try {
        const [datePart, timePart] = isoString.split("T");
        const [_year, month, day] = datePart.split("-");
        const dateObj = new Date(isoString);
        const weekDay = ["日", "月", "火", "水", "木", "金", "土"][dateObj.getDay()];

        let result = `${month}/${day}(${weekDay})`;

        if (timePart) {
            const [hour, minute] = timePart.split(":");
            result += ` ${hour}:${minute}`;
        }
        return result;
    } catch (e) { return isoString; }
}

// ───────────────────────────────────────────
// 📅 Googleカレンダー同期ロジック
// ───────────────────────────────────────────
async function handleSyncCalendar(replyToken: string) {
    try {
        // Notionから「今日以降」のイベントを取得
        const today = new Date().toISOString().split('T')[0];
        const events = await notion.databases.query({
            database_id: EVENT_DB_ID,
            filter: { property: PROP_EVENT_DATE, date: { on_or_after: today } }
        });

        let syncCount = 0;

        for (const page of events.results as any[]) {
            const title = page.properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
            const dateProp = page.properties[PROP_EVENT_DATE]?.date;
            if (!dateProp || !dateProp.start) continue; // 日付未設定はスキップ

            const gcalId = page.properties[PROP_EVENT_GCAL_ID]?.rich_text?.[0]?.plain_text;

            let startData: any = {};
            let endData: any = {};

            // 🕒 時間の計算（Notionの形式をGoogleカレンダーの形式に変換）
            if (dateProp.start.includes("T")) {
                // 時間指定がある場合
                startData = { dateTime: dateProp.start, timeZone: "Asia/Tokyo" };
                const endDate = dateProp.end || new Date(new Date(dateProp.start).getTime() + 60 * 60 * 1000).toISOString();
                endData = { dateTime: endDate, timeZone: "Asia/Tokyo" };
            } else {
                // 終日イベントの場合
                startData = { date: dateProp.start };
                const nextDay = new Date(new Date(dateProp.start).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                endData = { date: dateProp.end ? new Date(new Date(dateProp.end).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0] : nextDay };
            }

            // Googleカレンダーに送るデータの中身
            const eventBody = {
                summary: `[心理ゼミ] ${title}`,
                description: `🔗 Notion詳細ページ:\n${page.url}`,
                start: startData,
                end: endData,
            };

            if (gcalId) {
                // すでに登録済みなら「更新（上書き）」
                await calendar.events.update({ calendarId: GOOGLE_CALENDAR_ID, eventId: gcalId, requestBody: eventBody });
                syncCount++;
            } else {
                // まだカレンダーに無ければ「新規作成」
                const res = await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: eventBody });

                // 発行されたGoogleカレンダーのIDをNotionに保存しておく（次回ダブらないため）
                await notion.pages.update({
                    page_id: page.id,
                    properties: { [PROP_EVENT_GCAL_ID]: { rich_text: [{ text: { content: res.data?.id || "" } }] } }
                });
                syncCount++;
            }
        }
        await reply(replyToken, `✅ カレンダー同期完了！\n${syncCount}件のイベントをGoogleカレンダーに反映しました📅✨`);
    } catch (e: any) {
        console.error(e);
        await reply(replyToken, `❌ 同期エラー: ${e.message}`);
    }
}

// ───────────────────────────────────────────
// 📅 Googleカレンダー監視設定（初回のみ実行）
// ───────────────────────────────────────────
async function handleSetupWatch(replyToken: string) {
    try {
        const watchResponse = await calendar.events.watch({
            calendarId: GOOGLE_CALENDAR_ID,
            requestBody: {
                id: "shinrizemi-watch-" + Date.now(),
                type: "web_hook",
                address: "https://shinrizemi-linebot.web.app/api/calendar-webhook"
            }
        });

        // ★追加ポイント：受け取った結果をログに出力して「使った」ことにする
        console.log("監視設定レスポンス:", watchResponse.data);

        await reply(replyToken, `✅ カレンダーの監視設定（Watch）が完了しました！\n\n以降、Googleカレンダーで予定が追加・変更されると、自動的に裏側で同期が走ります。`);
    } catch (e: any) {
        console.error("Watch Error:", e);
        await reply(replyToken, `❌ 監視設定エラー: ${e.message}`);
    }
}

// ───────────────────────────────────────────
// 5. マイページ用 API: イベント情報の取得（Firestore爆速版）
// ───────────────────────────────────────────
export const getUserEvents = functions.region("asia-northeast1").https.onRequest(async (req: any, res: any) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const userId = req.query.userId;
    if (!userId) { res.status(400).json({ error: "No userId provided" }); return; }

    try {
        const memberSearch = await notion.databases.query({
            database_id: MEMBER_DB_ID,
            filter: { property: PROP_LINE_USER_ID, rich_text: { equals: userId } }
        });
        if (memberSearch.results.length === 0) {
            res.json({ planned: [], maybe: [], recommended: [], past: [] });
            return;
        }

        const memberId = memberSearch.results[0].id;
        const userTags = memberSearch.results[0].properties[PROP_MEMBER_TAGS]?.multi_select?.map((t: any) => t.name) || [];
        const today = new Date().toISOString().split('T')[0];

        const snapshot = await db.collection("events").orderBy("date", "asc").get();

        const planned: any[] = [];
        const maybe: any[] = [];
        const recommended: any[] = [];
        let past: any[] = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            const ev = { id: doc.id, title: data.title, date: data.date, tags: data.tags || [], category: data.category || "" };
            
            const joins = data.joins || [];
            const maybes = data.maybes || [];
            const declines = data.declines || [];

            if (data.date >= today) {
                if (joins.includes(memberId)) planned.push(ev);
                else if (maybes.includes(memberId)) maybe.push(ev);
                else if (!declines.includes(memberId)) {
                    if (userTags.some((tag: string) => ev.tags.includes(tag) || ev.category === tag)) {
                        recommended.push(ev);
                    }
                }
            } else {
                if (joins.includes(memberId)) past.push(ev);
            }
        });

        past = past.sort((a, b) => (b.date > a.date ? 1 : -1)).slice(0, 10);
        res.json({ planned, maybe, recommended, past });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
});

// ───────────────────────────────────────────
// 6. カレンダー＆詳細用 API（Firestore爆速キャッシュ版！）
// ───────────────────────────────────────────
export const getCalendarEvents = functions.region("asia-northeast1").https.onRequest(async (req: any, res: any) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    try {
// ▼▼ 修正後のコード ▼▼
        const snapshot = await db.collection("events").orderBy("date", "asc").get();
        const events: any[] = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // 🚨 強力なフィルター
            if (!data.category || data.category === "未分類" || data.category.includes("運営部") || data.category.includes("企画部")) return;
            events.push({
                id: doc.id,
                title: data.title || "無題",
                date: data.date,
                category: data.category,
                tags: data.tags || [],
                organizerIds: data.organizerIds || [],
                endDate: data.endDate || data.date, 
                startTime: data.startTime || "",
                // ▼ この1行を追加！
                endTime: data.endTime || ""
            });
        });

        res.json({ events });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
});

// ───────────────────────────────────────────
// 6. カレンダー＆詳細用 API（🛡️ 絶対に落ちない・究極セーフモード版！）
// ───────────────────────────────────────────
export const getEventDetails = functions.region("asia-northeast1").https.onRequest(async (req: any, res: any) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const eventId = req.query.eventId;
    const forceRefresh = req.query.forceRefresh === 'true'; 
    
    // IDがない場合は安全な空データを返す
    if (!eventId) { 
        return res.json({ details: "イベントIDが不明です。", joinsLineIds: [], maybesLineIds: [], declinesLineIds: [] }); 
    }

    try {
        const docRef = db.collection("events").doc(eventId);

        // 強制更新でなければキャッシュを返す
        if (!forceRefresh) {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                const data = docSnap.data();
                if (data && data.details !== undefined) {
                    return res.json({
                        details: data.details,
                        joinsLineIds: data.joinsLineIds || [],
                        maybesLineIds: data.maybesLineIds || [],
                        declinesLineIds: data.declinesLineIds || [],
                        // ▼▼▼ ここを追加！ ▼▼▼
                        date: data.date || "",
                        endDate: data.endDate || data.date || "",
                        startTime: data.startTime || "",
                        endTime: data.endTime || ""
                        
                        // ▲▲▲ ここまで ▲▲▲
                    });
                }
            }
        }

        // Notionからイベントページを取得
        const eventPage: any = await notion.pages.retrieve({ page_id: eventId });
        const joinsIds = eventPage.properties[PROP_JOIN]?.relation?.map((r:any) => r.id) || [];
        const maybesIds = eventPage.properties[PROP_MAYBE]?.relation?.map((r:any) => r.id) || [];
        const declinesIds = eventPage.properties[PROP_DECLINE]?.relation?.map((r:any) => r.id) || []; 

        // 参加者のLINE IDを安全に取得（0.3秒のインターバル付き）
        const getLineIds = async (ids: string[]) => {
            if(!ids || ids.length === 0) return [];
            const lineIds = [];
            for(const id of ids) {
                try {
                    const p: any = await notion.pages.retrieve({ page_id: id });
                    const lineId = p.properties[PROP_LINE_USER_ID]?.rich_text?.[0]?.plain_text;
                    if (lineId) lineIds.push(lineId);
                } catch(e) {
                    console.error(`Participant error (${id}):`, e);
                } finally {
                    await new Promise(resolve => setTimeout(resolve, 333));
                }
            }
            return lineIds;
        };

        const joinsLineIds = await getLineIds(joinsIds);
        const maybesLineIds = await getLineIds(maybesIds);
        const declinesLineIds = await getLineIds(declinesIds);

        let textContent = "";
        try {
            const blocks = await notion.blocks.children.list({ block_id: eventId });
            for (const block of blocks.results) {
                let blockText = "";
                const contentObj = block[block.type];
                if (contentObj && contentObj.rich_text) {
                    blockText = contentObj.rich_text.map((t:any) => t.plain_text).join("");
                }
                if (blockText.includes("運営用") || blockText.includes("以下は運営用")) break;

                if (blockText.trim()) {
                    if (block.type === 'heading_2' || block.type === 'heading_3') textContent += "\n■ " + blockText + "\n";
                    else if (block.type === 'bulleted_list_item') textContent += "・ " + blockText + "\n";
                    else textContent += blockText + "\n";
                }
            }
        } catch (e) {
            console.error("Blocks error:", e);
        }

        if(!textContent.trim()) {
            textContent = eventPage.properties[PROP_DETAIL_TEXT]?.rich_text?.map((t:any)=>t.plain_text).join("") || "詳細情報（本文）はまだ書かれていません。";
        }

        // キャッシュとして保存
        await docRef.set({
            details: textContent.trim(),
            joinsLineIds, maybesLineIds, declinesLineIds
        }, { merge: true });

        // ▼▼▼ ここを追加！最新の日付データを取得する ▼▼▼
        const latestSnap = await docRef.get();
        const latestData = latestSnap.data() || {};
        // ▲▲▲ ここまで ▲▲▲

        // 正常にデータを返す
        return res.json({ 
            details: textContent.trim(), 
            joinsLineIds, maybesLineIds, declinesLineIds,
            // ▼▼▼ ここも追加！ ▼▼▼
            date: latestData.date || "",
            endDate: latestData.endDate || latestData.date || "",
            startTime: latestData.startTime || ""
            // ▲▲▲ ここまで ▲▲▲
        });

    } catch(e: any) { 
        console.error("Event Detail Critical Error:", e);
        // 🚨 修正：エラーでBotを落とさず、「安全なデータ」としてエラー文を返す！！
        return res.json({ 
            details: `⚠️ データの取得に失敗しました。\n\n【エラー詳細】\n${e.message}\n\n※このメッセージが表示された場合は、翔大にお知らせください。`, 
            joinsLineIds: [], 
            maybesLineIds: [], 
            declinesLineIds: [] 
        });
    }
});

// ───────────────────────────────────────────
// 7. 出欠ステータスの更新 API
// ───────────────────────────────────────────
export const updateEventStatus = functions.region("asia-northeast1").https.onRequest(async (req: any, res: any) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    try {
        const { userId, eventId, status } = req.body;
        if (!userId || !eventId || !status) { res.status(400).json({ error: "Missing parameters" }); return; }

        const memberSearch = await notion.databases.query({
            database_id: MEMBER_DB_ID,
            filter: { property: PROP_LINE_USER_ID, rich_text: { equals: userId } }
        });
        if (memberSearch.results.length === 0) { res.status(404).json({ error: "User not found" }); return; }
        const memberId = memberSearch.results[0].id;

        const eventPage: any = await notion.pages.retrieve({ page_id: eventId });
        let joins = eventPage.properties[PROP_JOIN]?.relation?.map((r:any) => r.id) || [];
        let maybes = eventPage.properties[PROP_MAYBE]?.relation?.map((r:any) => r.id) || [];
        let declines = eventPage.properties[PROP_DECLINE]?.relation?.map((r:any) => r.id) || [];

        joins = joins.filter((id: string) => id !== memberId);
        maybes = maybes.filter((id: string) => id !== memberId);
        declines = declines.filter((id: string) => id !== memberId);

        if (status === "join") joins.push(memberId);
        else if (status === "maybe") maybes.push(memberId);
        else if (status === "decline") declines.push(memberId);

        await notion.pages.update({
            page_id: eventId,
            properties: {
                [PROP_JOIN]: { relation: joins.map((id: string) => ({ id })) },
                [PROP_MAYBE]: { relation: maybes.map((id: string) => ({ id })) },
                [PROP_DECLINE]: { relation: declines.map((id: string) => ({ id })) }
            }
        });

        const docRef = db.collection("events").doc(eventId);
        const docSnap = await docRef.get();
        let joinsLineIds: string[] = [], maybesLineIds: string[] = [], declinesLineIds: string[] = [];
        
        if (docSnap.exists) {
            const data = docSnap.data();
            joinsLineIds = data?.joinsLineIds || []; 
            maybesLineIds = data?.maybesLineIds || []; 
            declinesLineIds = data?.declinesLineIds || [];
        }
        
        joinsLineIds = joinsLineIds.filter((id: string) => id !== userId);
        maybesLineIds = maybesLineIds.filter((id: string) => id !== userId);
        declinesLineIds = declinesLineIds.filter((id: string) => id !== userId);

        if (status === "join") joinsLineIds.push(userId);
        else if (status === "maybe") maybesLineIds.push(userId);
        else if (status === "decline") declinesLineIds.push(userId);

        await docRef.set({
            joins, maybes, declines,
            joinsLineIds, maybesLineIds, declinesLineIds,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        res.json({ success: true });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
});

// ───────────────────────────────────────────
// 8. Firestore同期機能 (自動 & 手動)
// ───────────────────────────────────────────

// ★ 共通の同期ロジック（確実に動かすための関数）
async function runEventSync() {
    const today = new Date();
    today.setDate(1); 
    const startOfMonth = today.toISOString().split('T')[0];

    const response = await notion.databases.query({
        database_id: EVENT_DB_ID,
        // 過去の合宿も反映させるなら、ここの filter 行を消すか条件を緩めてください！
        filter: { property: PROP_EVENT_DATE, date: { on_or_after: startOfMonth } },
        sorts: [{ property: PROP_EVENT_DATE, direction: "ascending" }]
    });

    const batch = db.batch();
    for (const page of response.results) {
        let cat = "未分類";
        const catProp = page.properties[PROP_EVENT_CAT];
        if (catProp) {
            if (catProp.type === "select") cat = catProp.select?.name || "未分類";
            else if (catProp.type === "multi_select") {
                const tags = catProp.multi_select?.map((t:any) => t.name) || [];
                cat = tags.length > 0 ? tags.join(", ") : "未分類";
            }
            else if (catProp.type === "rich_text") {
                const text = catProp.rich_text?.map((t:any) => t.plain_text).join("");
                cat = text ? text : "未分類";
            }
        }

        const title = page.properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
        
        // ▼▼ 修正箇所：終了日と時間もバッチリ取得する！ ▼▼
        const dateData = page.properties[PROP_EVENT_DATE]?.date;
        const rawDate = dateData?.start || "";
        const rawEndDate = dateData?.end || "";
        
        const dateStr = rawDate ? rawDate.split('T')[0] : ""; 
        const endDateStr = rawEndDate ? rawEndDate.split('T')[0] : dateStr;
        
        // 時間を切り出す（"2026-03-22T09:00:00" -> "09:00"）
        const startTime = rawDate && rawDate.includes('T') ? rawDate.split('T')[1].substring(0, 5) : "";
        const endTime = rawEndDate && rawEndDate.includes('T') ? rawEndDate.split('T')[1].substring(0, 5) : "";
        // ▲▲ ここまで ▲▲

        const tags = page.properties[PROP_EVENT_TAGS]?.multi_select?.map((t:any)=>t.name) || [];
        const organizerIds = page.properties["主催者"]?.relation?.map((r:any) => r.id) || [];
        const joins = page.properties[PROP_JOIN]?.relation?.map((r:any) => r.id) || [];
        const maybes = page.properties[PROP_MAYBE]?.relation?.map((r:any) => r.id) || [];
        const declines = page.properties[PROP_DECLINE]?.relation?.map((r:any) => r.id) || [];

        const eventRef = db.collection("events").doc(page.id);
        batch.set(eventRef, {
            id: page.id, title, date: dateStr, category: cat, tags, organizerIds,
            // 抽出した終了日・時間をデータベースに保存！
            endDate: endDateStr, startTime, endTime,
            joins, maybes, declines, updatedAt: new Date().toISOString()
        }, { merge: true });
    }
    await batch.commit();
    console.log("✅ Firestoreへのイベント同期完了！");
}

// ① 1時間に1回自動で動くタイマー
export const syncEventsToFirestore = functions.region("asia-northeast1").pubsub.schedule('every 1 hours').onRun(async (context) => {
    try {
        await runEventSync();
    } catch(e) { console.error("❌ イベント同期エラー:", e); }
});

// ② 手動でURLから動かす窓口（★ここを確実に動くように修正しました！）
export const manualSyncEvents = functions.region("asia-northeast1").https.onRequest(async (req: any, res: any) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    try {
        await runEventSync(); // 直接同期プログラムを実行する
        res.json({ success: true, message: "同期が完了しました！カレンダーを開いてみてください！" });
    } catch(e:any) { 
        console.error(e);
        res.status(500).json({ error: e.message }); 
    }
});

// ───────────────────────────────────────────
// 9. LINE用：「直近のイベント」カルーセル送信
// ───────────────────────────────────────────
async function handleRecentEvents(replyToken: string) {
    try {
        const today = new Date();
        const twoWeeksLater = new Date();
        twoWeeksLater.setDate(today.getDate() + 14);

        const response = await notion.databases.query({
            database_id: EVENT_DB_ID,
            filter: {
                and: [
                    { property: PROP_EVENT_DATE, date: { on_or_after: today.toISOString().split('T')[0] } },
                    { property: PROP_EVENT_DATE, date: { on_or_before: twoWeeksLater.toISOString().split('T')[0] } }
                ]
            },
            sorts: [{ property: PROP_EVENT_DATE, direction: "ascending" }]
        });

        const bubbles: any[] = [];
        for (const page of response.results) {
            let cat = "未分類";
            const catProp = page.properties[PROP_EVENT_CAT];
            if (catProp) {
                if (catProp.type === "select") cat = catProp.select?.name || "未分類";
                else if (catProp.type === "multi_select") {
                    const tags = catProp.multi_select?.map((t:any) => t.name) || [];
                    cat = tags.length > 0 ? tags.join(", ") : "未分類";
                }
                else if (catProp.type === "rich_text") {
                    const text = catProp.rich_text?.map((t:any) => t.plain_text).join("");
                    cat = text ? text : "未分類";
                }
            }
            // 運営部や企画部の内部イベントは除外
            if (cat.includes("運営部") || cat.includes("企画部")) continue;

            const title = page.properties[PROP_EVENT_NAME]?.title[0]?.plain_text || "無題";
            const displayDate = formatDate(page.properties[PROP_EVENT_DATE]?.date?.start);

            // ▼ フルサイズのイベントカードを作成
            bubbles.push({
                type: "bubble", header: { type: "box", layout: "vertical", contents: [{ type: "text", text: cat, color: "#aaaaaa", size: "xs" }, { type: "text", text: title, weight: "bold", size: "lg", wrap: true }] },
                body: { type: "box", layout: "vertical", contents: [{ type: "box", layout: "baseline", contents: [{ type: "text", text: "📅", flex: 1, size: "sm" }, { type: "text", text: displayDate, flex: 5, size: "sm", color: "#666666" }] }, { type: "box", layout: "baseline", margin: "md", contents: [{ type: "text", text: "👥", flex: 1, size: "sm" }, { type: "text", text: `参加: ${page.properties[PROP_JOIN]?.relation?.length || 0}名`, flex: 5, size: "sm", color: "#666666" }] }] },
                footer: { type: "box", layout: "vertical", spacing: "sm", contents: [{ type: "box", layout: "horizontal", spacing: "sm", contents: [{ type: "button", style: "primary", color: "#2ecc71", height: "sm", action: { type: "postback", label: "参加👍", data: `action=join&eventId=${page.id}`, displayText: `「${title}」に参加します！` } }, { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "迷い中🤔", data: `action=maybe&eventId=${page.id}`, displayText: `「${title}」迷い中です…` } }] }, { type: "box", layout: "horizontal", spacing: "sm", contents: [{ type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "不参加😢", data: `action=decline&eventId=${page.id}`, displayText: `「${title}」今回は不参加で…` } }, { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "参加者・詳細📄", data: `action=detail&eventId=${page.id}` } }] }] }
            });

            if (bubbles.length >= 10) break; // LINEのカルーセル上限（10枚）でストップ
        }

        if (bubbles.length === 0) { await reply(replyToken, "直近2週間の全体向けイベントは現在ありません！"); return; }
        await lineClient.replyMessage(replyToken, { type: "flex", altText: "直近のイベント一覧", contents: { type: "carousel", contents: bubbles } });
    } catch (e) { console.error(e); await reply(replyToken, "イベントの取得に失敗しました。"); }
}

// 🎮 探索ポータル（intro.html）専用API：経験値更新 ＆ ランキング取得
// ============================================================================
// TypeScriptのエラーを回避するため、内部で安全にcorsを読み込みます
const corsPortal = require('cors')({ origin: true });

// 1. 経験値を保存するAPI
export const updateIntroExp = functions.region('asia-northeast1').https.onRequest((req, res) => {
    corsPortal(req, res, async () => {
        if (req.method !== 'POST') {
            res.status(405).send('Method Not Allowed');
            return;
        }
        try {
            const { lineId, exp } = req.body;
            if (!lineId || typeof exp !== 'number') {
                res.status(400).json({ error: 'Invalid parameters' });
                return;
            }
            
            const db = admin.firestore();
            // set({ merge: true }) にすることで、まだプロフィール未登録のユーザーでもエラーにならずに保存できます
            await db.collection('users').doc(lineId).set({
                introExp: exp,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            res.status(200).json({ success: true, exp });
        } catch (error) {
            console.error('Error in updateIntroExp:', error);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// 2. ランキング用にユーザーデータを取得する専用API
export const getIntroRanking = functions.region('asia-northeast1').https.onRequest((req, res) => {
    corsPortal(req, res, async () => {
        if (req.method !== 'GET') {
            res.status(405).send('Method Not Allowed');
            return;
        }
        try {
            const db = admin.firestore();
            const snapshot = await db.collection('users').get();
            const users: any[] = [];
            
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data && data.profile && data.profile.name) {
                    users.push({
                        id: doc.id, 
                        name: data.profile.name,
                        icon: data.profile.pictureUrl || "https://cdn-icons-png.flaticon.com/512/847/847969.png",
                        univ: data.profile.university || "未設定",
                        // ▼▼ faculty と bio を追加！ ▼▼
                        faculty: data.profile.faculty || "未設定",
                        grade: data.profile.grade || "",
                        message: data.profile.statusMessage || data.profile.message || "よろしくお願いします！",
                        bio: data.profile.bio || "まだ自己紹介が入力されていません。",
                        // ▲▲ ここまで ▲▲
                        exp: typeof data.introExp === 'number' ? data.introExp : 0
                    });
                }
            });

            res.status(200).json(users);
        } catch (error) {
            console.error('Error in getIntroRanking:', error);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// ... ファイル上部のインポート等はそのまま維持してください ...

// ============================================================================
// 📅 Notionイベント全件取得（ページネーション ＆ Firestoreキャッシュ）
// ============================================================================
// ※ corsが未定義の場合は追加してください： const cors = require('cors')({ origin: true });
// ============================================================================
// 📅 Notionイベント全件取得（ページネーション ＆ Firestoreキャッシュ）
// ============================================================================
export const getNotionEvents = functions.region('asia-northeast1').https.onRequest((req, res) => {
    const corsHandler = require('cors')({ origin: true });

    corsHandler(req, res, async () => {
        try {
            const db = admin.firestore();
            const cacheRef = db.collection('system').doc('notion_events_cache');
            
            // ----------------------------------------------------
            // 🚀 STEP 1: Firestore キャッシュの確認
            // ----------------------------------------------------
            const cacheDoc = await cacheRef.get();
            const cacheData = cacheDoc.data(); // データを取得

            // 修正：cacheData が存在するかどうかのチェックを追加（TypeScriptエラー回避）
            if (cacheDoc.exists && cacheData) {
                const lastUpdated = cacheData.updatedAt?.toDate();
                const now = new Date();
                
                // キャッシュの有効期限を「1時間（3600000ミリ秒）」に設定
                if (lastUpdated && (now.getTime() - lastUpdated.getTime() < 3600000)) {
                    console.log("⚡ Firestoreのキャッシュからイベントデータを返却しました");
                    // cacheDataが確実に存在するのでエラーにならない
                    res.status(200).json(cacheData.events || []);
                    return;
                }
            }

            // ----------------------------------------------------
            // 🌐 STEP 2: Notion APIからページネーションで全件取得
            // ----------------------------------------------------
            const notion = new Client({ auth: process.env.NOTION_TOKEN });
            const databaseId = process.env.NOTION_DATABASE_ID;

            if (!databaseId) {
                throw new Error('Notion Database ID is missing.');
            }

            let allEvents: any[] = [];
            let hasMore = true;
            let nextCursor: string | undefined = undefined;

            while (hasMore) {
                const response = await notion.databases.query({
                    database_id: databaseId,
                    start_cursor: nextCursor,
                    sorts: [
                        { property: '開催日', direction: 'descending' }
                    ]
                });

                const parsedEvents = response.results.map((page: any) => {
                    const props = page.properties;
                    return {
                        id: page.id,
                        title: props['イベント名']?.title?.[0]?.plain_text || '無題のイベント',
                        date: props['開催日']?.date?.start || null,
                        endDate: props['開催日']?.date?.end || null,
                        category: props['カテゴリ']?.select?.name || 'その他',
                        details: props['詳細']?.rich_text?.map((t:any) => t.plain_text).join('') || '',
                        status: props['ステータス']?.select?.name || '',
                        sender: props['発信者']?.select?.name || '',
                        participants: props['参加者']?.rich_text?.[0]?.plain_text || '',
                        pending: props['迷い中']?.rich_text?.[0]?.plain_text || '',
                        absent: props['不参加']?.rich_text?.[0]?.plain_text || ''
                    };
                });

                allEvents = allEvents.concat(parsedEvents);
                
                hasMore = response.has_more;
                nextCursor = response.next_cursor ?? undefined;
            }

            // ----------------------------------------------------
            // 💾 STEP 3: 取得した全件データをFirestoreにキャッシュ保存
            // ----------------------------------------------------
            await cacheRef.set({
                events: allEvents,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`🌐 Notion APIから ${allEvents.length} 件のイベントを取得し、キャッシュを更新しました`);
            res.status(200).json(allEvents);

        } catch (error) {
            console.error('Error fetching Notion events:', error);
            res.status(500).json({ error: 'Server error' });
        }
    });
});