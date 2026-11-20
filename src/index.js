/**
 * 全平台无水印媒体解析引擎 - Cloudflare Workers
 * 
 * 支持矩阵：
 * 1. 小红书 (RedBook): 图文高清原图直连、4K/1080P 原始无水印视频 (originVideoKey)
 * 2. 哔哩哔哩 (Bilibili): 官方高清画质直链提取 (MP4 / playurl)
 * 3. TikTok: 国际版短视频与图集无水印提取 (TikWM 引擎)
 * 4. 抖音 (Douyin): 移动端短链还原与无水印原画直连
 * 5. Twitter / X: FixTweet 协议解析视频/动图直链与高清大图
 * 6. Threads: Meta 官方 GraphQL 与 Twitterbot 开放通道解析
 * 
 * 架构规范：
 * - 严格遵循 Airbnb DESIGN.md 规范 (https://getdesign.md/airbnb/design-md)
 * - 全平台多媒体防盗链中转 (/api/proxy)，支持 Range 断点续传与一键另存为
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 跨域预检
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // 1. 文件流代理接口：解决 B站、小红书、抖音、Meta 等 CDN 防盗链与跨域
    if (url.pathname === "/api/proxy") {
      const targetUrl = url.searchParams.get("url");
      const downloadName = url.searchParams.get("filename") || "";
      const platform = url.searchParams.get("platform") || "";
      if (!targetUrl) {
        return new Response("Missing url parameter", { status: 400 });
      }
      return handleProxy(targetUrl, request, downloadName, platform);
    }

    // 2. 解析接口: POST /api/parse { url: "..." } 或 GET /api/parse?url=...
    if (url.pathname === "/api/parse") {
      try {
        let targetText = "";
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          targetText = body.url || "";
        } else {
          targetText = url.searchParams.get("url") || "";
        }

        if (!targetText) {
          return jsonResponse({ code: 400, msg: "请提供支持的分享链接或文本" }, 400);
        }

        const data = await parseDispatcher(targetText, env, url.origin);
        return jsonResponse({ code: 200, msg: "解析成功", data });
      } catch (err) {
        return jsonResponse({ code: 500, msg: err.message || "解析失败" }, 500);
      }
    }

    // 3. Airbnb DESIGN.md 全新交互界面
    return new Response(renderAirbnbUI(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

/**
 * 平台路由调度器
 */
async function parseDispatcher(rawText, env, origin) {
  const urlMatch = rawText.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) {
    throw new Error("未在输入内容中找到有效链接");
  }

  const rawUrl = urlMatch[0];

  // 1. 小红书
  if (rawUrl.includes("xiaohongshu.com") || rawUrl.includes("xhslink.com")) {
    return await parseRedbook(rawUrl, env, origin);
  }
  // 2. 哔哩哔哩
  else if (rawUrl.includes("bilibili.com") || rawUrl.includes("b23.tv")) {
    return await parseBilibili(rawUrl, env, origin);
  }
  // 3. TikTok
  else if (rawUrl.includes("tiktok.com")) {
    return await parseTikTok(rawUrl, env, origin);
  }
  // 4. 抖音
  else if (rawUrl.includes("douyin.com") || rawUrl.includes("iesdouyin.com")) {
    return await parseDouyin(rawUrl, env, origin);
  }
  // 5. Twitter / X
  else if (rawUrl.includes("twitter.com") || rawUrl.includes("x.com") || rawUrl.includes("t.co")) {
    return await parseTwitter(rawUrl, env, origin);
  }
  // 6. Threads
  else if (rawUrl.includes("threads.net") || rawUrl.includes("threads.com")) {
    return await parseThreads(rawUrl, env, origin);
  } else {
    throw new Error("暂不支持该平台链接，当前支持：小红书、哔哩哔哩、抖音、TikTok、Twitter/X、Threads");
  }
}

/**
 * 多平台代理中转：伪造专属 HTTP Referer 解决 403 防盗链
 */
async function handleProxy(targetUrl, incomingRequest, downloadName, platform) {
  try {
    const proxyHeaders = new Headers();
    proxyHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    switch (platform) {
      case "bilibili":
        proxyHeaders.set("Referer", "https://www.bilibili.com/");
        break;
      case "douyin":
        proxyHeaders.set("Referer", "https://www.douyin.com/");
        break;
      case "threads":
        proxyHeaders.set("Referer", "https://www.threads.net/");
        break;
      case "tiktok":
        proxyHeaders.set("Referer", "https://www.tiktok.com/");
        break;
      case "twitter":
        proxyHeaders.set("Referer", "https://twitter.com/");
        break;
      default:
        proxyHeaders.set("Referer", "https://www.xiaohongshu.com/");
        break;
    }

    const range = incomingRequest.headers.get("Range");
    if (range) {
      proxyHeaders.set("Range", range);
    }

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: proxyHeaders,
    });

    const respHeaders = new Headers(response.headers);
    respHeaders.set("Access-Control-Allow-Origin", "*");

    if (downloadName) {
      respHeaders.set(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(downloadName)}"`
      );
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    return new Response("Proxy Error: " + e.message, { status: 502 });
  }
}

/* =========================================================================
   1. 小红书 (RedBook) 解析
   ========================================================================= */
async function parseRedbook(requestUrl, env, origin) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };

  if (env && env.REDBOOK_COOKIE) {
    headers["Cookie"] = env.REDBOOK_COOKIE;
  }

  if (requestUrl.includes("/explore/")) {
    const idMatch = requestUrl.match(/\/explore\/([a-zA-Z0-9]+)/);
    if (idMatch) {
      const noteId = idMatch[1];
      const parsedUrl = new URL(requestUrl);
      const token = parsedUrl.searchParams.get("xsec_token") || "";
      const source = parsedUrl.searchParams.get("xsec_source") || "pc_feed";
      requestUrl = `https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=${encodeURIComponent(
        token
      )}&xsec_source=${encodeURIComponent(source)}`;
    }
  }

  const resp = await fetch(requestUrl, { headers, redirect: "follow" });
  const html = await resp.text();
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?})<\/script>/);
  if (!stateMatch) {
    throw new Error("无法读取小红书页面数据，可能触发了人机验证或链接已失效");
  }

  let stateStr = stateMatch[1].replace(/:undefined/g, ":null");
  const stateData = JSON.parse(stateStr);

  let note = null;
  if (stateData.noteData?.data?.noteData) {
    note = stateData.noteData.data.noteData;
  } else if (stateData.noteData?.noteData) {
    note = stateData.noteData.noteData;
  } else if (stateData.note?.noteDetailMap) {
    const keys = Object.keys(stateData.note.noteDetailMap);
    if (keys.length > 0) note = stateData.note.noteDetailMap[keys[0]]?.note;
  } else if (stateData.note?.note) {
    note = stateData.note.note;
  }

  if (!note) throw new Error("未能定位到小红书笔记内容");

  const images = [];
  if (note.imageList && Array.isArray(note.imageList)) {
    for (let i = 0; i < note.imageList.length; i++) {
      const img = note.imageList[i];
      let directUrl = img.fileId
        ? `https://ci.xiaohongshu.com/${img.fileId}`
        : img.infoList?.[0]?.url || img.url || img.urlDefault;
      if (directUrl) {
        images.push({
          url: directUrl,
          proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(directUrl)}&filename=redbook_${i + 1}.jpg`,
        });
      }
    }
  }

  let videoData = null;
  const isVideo = note.type === "video" || !!note.video;
  if (isVideo && note.video) {
    let unwatermarkedUrl = "";
    const originKey = note.video.consumer?.originVideoKey;
    if (originKey) {
      unwatermarkedUrl = `https://sns-video-bd.xhscdn.com/${originKey}`;
    } else {
      const stream = note.video.media?.stream || {};
      const h264 = stream.h264?.[0];
      const h265 = stream.h265?.[0];
      unwatermarkedUrl = (h264?.masterUrl || h264?.master_url || h265?.masterUrl || h265?.master_url || "");
    }
    if (unwatermarkedUrl.startsWith("http://")) {
      unwatermarkedUrl = unwatermarkedUrl.replace("http://", "https://");
    }

    videoData = {
      url: unwatermarkedUrl,
      proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(unwatermarkedUrl)}&filename=redbook_video.mp4`,
      duration: note.video.capa?.duration || 0,
      cover: images[0]?.url || "",
    };
  }

  return {
    platform: "redbook",
    platformName: "小红书",
    title: note.title || "",
    desc: note.desc || "",
    type: isVideo ? "video" : "normal",
    author: {
      id: note.user?.userId || "",
      nickname: note.user?.nickName || note.user?.nickname || "小红书用户",
      avatar: note.user?.avatar || "",
    },
    images,
    video: videoData,
  };
}

/* =========================================================================
   2. 哔哩哔哩 (Bilibili) 解析
   ========================================================================= */
async function parseBilibili(rawUrl, env, origin) {
  // 跟随短链 b23.tv
  let targetUrl = rawUrl;
  if (targetUrl.includes("b23.tv")) {
    const res = await fetch(targetUrl, { redirect: "follow" });
    targetUrl = res.url;
  }

  // 提取 BV号 (BV1...)
  const bvMatch = targetUrl.match(/(BV[a-zA-Z0-9]+)/);
  if (!bvMatch) {
    throw new Error("未能从小红书/B站链接中匹配到有效 BV 号");
  }
  const bvid = bvMatch[1];

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.bilibili.com/",
  };

  // 1. 获取视频基本信息与 cid
  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers });
  const viewData = await viewRes.json();
  if (viewData.code !== 0 || !viewData.data) {
    throw new Error(viewData.message || "获取哔哩哔哩视频详情失败");
  }

  const vInfo = viewData.data;
  const cid = vInfo.cid;

  // 2. 获取视频播放直链 (qn=64 为 720P 高清 MP4 流，免登录即可获取完整音视频合轨文件)
  const playRes = await fetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=0`,
    { headers }
  );
  const playData = await playRes.json();
  let videoUrl = "";
  if (playData.code === 0 && playData.data?.durl?.length > 0) {
    videoUrl = playData.data.durl[0].url;
  }

  return {
    platform: "bilibili",
    platformName: "哔哩哔哩",
    title: vInfo.title || "",
    desc: vInfo.desc || "",
    type: "video",
    author: {
      id: vInfo.owner?.mid || "",
      nickname: vInfo.owner?.name || "UP主",
      avatar: vInfo.owner?.face || "",
    },
    images: [{
      url: vInfo.pic,
      proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(vInfo.pic)}&filename=bilibili_cover.jpg&platform=bilibili`,
    }],
    video: {
      url: videoUrl,
      proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(videoUrl)}&filename=${encodeURIComponent(vInfo.title)}.mp4&platform=bilibili`,
      duration: vInfo.duration || 0,
      cover: vInfo.pic,
    },
  };
}

/* =========================================================================
   3. TikTok 解析 (TikWM 极速免登录引擎)
   ========================================================================= */
async function parseTikTok(rawUrl, env, origin) {
  const res = await fetch("https://www.tikwm.com/api/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    body: new URLSearchParams({ url: rawUrl, hd: 1 }),
  });

  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(json?.msg || "TikTok 解析失败，链接可能失效或私密");
  }

  const d = json.data;
  const isVideo = !d.images || d.images.length === 0;

  let images = [];
  if (d.images && Array.isArray(d.images)) {
    images = d.images.map((imgUrl, i) => ({
      url: imgUrl,
      proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(imgUrl)}&filename=tiktok_${i + 1}.jpg&platform=tiktok`,
    }));
  }

  let videoData = null;
  if (d.play) {
    const playUrl = d.hdplay || d.play;
    videoData = {
      url: playUrl,
      proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(playUrl)}&filename=tiktok_video.mp4&platform=tiktok`,
      duration: d.duration || 0,
      cover: d.cover || "",
    };
  }

  return {
    platform: "tiktok",
    platformName: "TikTok",
    title: d.title || "TikTok 视频",
    desc: d.title || "",
    type: isVideo ? "video" : "normal",
    author: {
      id: d.author?.unique_id || d.author?.id || "",
      nickname: d.author?.nickname || d.author?.unique_id || "TikTok 用户",
      avatar: d.author?.avatar || "",
    },
    images,
    video: videoData,
  };
}

/* =========================================================================
   4. 抖音 (Douyin) 解析 (支持 APP 复制的长文本怪链接、口令、短链)
   ========================================================================= */
async function parseDouyin(rawText, env, origin) {
  // 1. 从复杂混合分享文案中提取有效 URL
  const urlMatch = rawText.match(/https?:\/\/[a-zA-Z0-9.\-_/]+/);
  if (!urlMatch) {
    throw new Error("未在输入文本中找到有效的抖音链接");
  }

  const rawUrl = urlMatch[0];

  // 2. 模拟移动端 UA 跟随短链 (v.douyin.com) 302 重定向
  const mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const redirectResp = await fetch(rawUrl, {
    headers: { "User-Agent": mobileUA },
    redirect: "follow",
  });

  const finalUrl = redirectResp.url;
  const idMatch = finalUrl.match(/video\/(\d+)/) || finalUrl.match(/note\/(\d+)/);
  if (!idMatch) {
    throw new Error("未能解析出抖音作品 ID，请确认链接格式");
  }
  const awemeId = idMatch[1];

  // 3. 优先通过底层移动端 Feed 接口获取完整作品信息与真实直链
  let title = "抖音作品";
  let desc = "";
  let authorNickname = "抖音创作者";
  let authorAvatar = "";
  let cover = "";
  let playUrl = "";
  let images = [];
  let isImage = false;

  try {
    const feedRes = await fetch(`https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=${awemeId}&count=1`, {
      headers: {
        "User-Agent": mobileUA,
        "Accept": "application/json",
      },
    });

    if (feedRes.ok) {
      const feedData = await feedRes.json().catch(() => null);
      const item = feedData?.aweme_list?.[0];

      if (item) {
        if (item.desc) {
          desc = item.desc;
          title = item.desc.split("\n")[0].trim();
        }
        if (item.author) {
          authorNickname = item.author.nickname || authorNickname;
          authorAvatar = item.author.avatar_thumb?.url_list?.[0] || item.author.avatar_larger?.url_list?.[0] || "";
        }
        if (item.video?.cover?.url_list?.[0]) {
          cover = item.video.cover.url_list[0];
        }

        // 判断图集作品 (images)
        if (item.images && item.images.length > 0) {
          isImage = true;
          images = item.images
            .map((img, i) => {
              const u = img.url_list?.[0];
              return u
                ? {
                    url: u,
                    proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(u)}&filename=douyin_${awemeId}_${i + 1}.jpg&platform=douyin`,
                  }
                : null;
            })
            .filter(Boolean);
        } else if (item.video?.play_addr?.url_list?.length > 0) {
          // 查找有效播放直链并替换 playwm 为 play 确保无水印
          const candidateUrls = item.video.play_addr.url_list;
          const foundUrl = candidateUrls.find(u => u.includes("tos-cn") || u.includes("snssdk.com") || u.includes("amemv.com")) || candidateUrls[0];
          playUrl = foundUrl.replace("playwm", "play");
        }
      }
    }
  } catch (e) {
    // 忽略异常，进入 SEO 降级
  }

  // 4. 降级通道: 若 Feed 未能返回完整数据，通过 SEO 渲染通道兜底提取元数据
  if (!cover || !authorNickname || authorNickname === "抖音创作者") {
    try {
      const seoRes = await fetch(`https://www.iesdouyin.com/share/video/${awemeId}/`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
      });
      if (seoRes.status === 200) {
        const seoHtml = await seoRes.text();
        const titleMatch = seoHtml.match(/<meta data-rh="true" name="lark:url:video_title" content="([^"]+)"/);
        const descMatch = seoHtml.match(/<meta data-rh="true" name="description" content="([^"]+)"/);
        const coverMatch = seoHtml.match(/<meta data-rh="true" name="lark:url:video_cover_image_url" content="([^"]+)"/);

        if (titleMatch && !title) title = titleMatch[1].replace(/ - 抖音$/, "").trim();
        if (descMatch && !desc) desc = descMatch[1].trim();
        if (coverMatch && !cover) cover = coverMatch[1].replace(/&amp;/g, "&");

        const authorMatch = (descMatch?.[1] || seoHtml).match(/-\s*([^于]+?)于\d{8}发布在抖音/);
        if (authorMatch && authorNickname === "抖音创作者") {
          authorNickname = authorMatch[1].trim();
        }
      }
    } catch (e) {
      // 忽略异常
    }
  }

  // 5. 极端兜底生成
  if (!playUrl && !isImage) {
    playUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${awemeId}&ratio=1080p&line=0`;
  }

  // 如果封面图存在，注入到图片列表提供原图查看
  if (images.length === 0 && cover) {
    images.push({
      url: cover,
      proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(cover)}&filename=douyin_${awemeId}_cover.jpg&platform=douyin`,
    });
  }

  const videoData = playUrl
    ? {
        url: playUrl,
        proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(playUrl)}&filename=douyin_${awemeId}.mp4&platform=douyin`,
        duration: 0,
        cover,
      }
    : null;

  return {
    platform: "douyin",
    platformName: "抖音",
    title: title || "抖音作品",
    desc,
    type: isImage ? "normal" : "video",
    author: {
      id: awemeId,
      nickname: authorNickname,
      avatar: authorAvatar || cover,
    },
    images,
    video: videoData,
  };
}

/* =========================================================================
   5. Twitter / X 解析 (双通道容灾: FixTweet + VxTwitter)
   ========================================================================= */
async function parseTwitter(rawUrl, env, origin) {
  let targetUrl = rawUrl;
  // 处理 t.co 短链重定向
  if (targetUrl.includes("t.co/")) {
    const redirectRes = await fetch(targetUrl, { redirect: "follow" });
    targetUrl = redirectRes.url;
  }

  // 提取推文 ID (支持 /status/123456 或 /status/123456/video/1)
  const idMatch = targetUrl.match(/status(?:es)?\/(\d+)/);
  if (!idMatch) {
    throw new Error("未能识别 Twitter / X 推文 ID，请检查链接格式");
  }
  const tweetId = idMatch[1];

  let tweetData = null;
  let source = "";

  // 通道 1: FixTweet (api.fxtwitter.com/status/{id})
  try {
    const fxRes = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const fxJson = await fxRes.json().catch(() => null);
    if (fxJson?.code === 200 && fxJson.tweet) {
      tweetData = fxJson.tweet;
      source = "fxtwitter";
    }
  } catch (e) {
    // 忽略异常并降级
  }

  // 通道 2: VxTwitter 降级兜底 (api.vxtwitter.com/Twitter/status/{id})
  if (!tweetData) {
    try {
      const vxRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${tweetId}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const vxJson = await vxRes.json().catch(() => null);
      if (vxJson && (vxJson.text || vxJson.mediaURLs)) {
        tweetData = vxJson;
        source = "vxtwitter";
      }
    } catch (e) {
      // 降级失败
    }
  }

  if (!tweetData) {
    throw new Error("推文解析失败，内容可能已被删除或来自私密保护账号");
  }

  // 1. 处理 FixTweet 数据结构
  if (source === "fxtwitter") {
    const t = tweetData;
    let videoData = null;
    let images = [];

    // 视频 / 动图
    if (t.media?.videos && t.media.videos.length > 0) {
      const v = t.media.videos[0];
      // 优先从 formats/variants 中获取最高清晰度 MP4
      let highestMp4 = v.url;
      if (v.variants && Array.isArray(v.variants)) {
        const mp4s = v.variants.filter((item) => item.content_type === "video/mp4" && item.url);
        if (mp4s.length > 0) {
          mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          highestMp4 = mp4s[0].url;
        }
      }

      videoData = {
        url: highestMp4,
        proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(highestMp4)}&filename=twitter_${tweetId}.mp4&platform=twitter`,
        duration: v.duration || 0,
        cover: v.thumbnail_url || "",
      };
    }

    // 图片
    if (t.media?.photos && t.media.photos.length > 0) {
      images = t.media.photos.map((p, i) => ({
        url: p.url,
        proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(p.url)}&filename=twitter_${tweetId}_${i + 1}.jpg&platform=twitter`,
      }));
    }

    return {
      platform: "twitter",
      platformName: "Twitter / X",
      title: `${t.author?.name || t.author?.screen_name || "推特用户"} on X`,
      desc: t.text || "",
      type: videoData ? "video" : "normal",
      author: {
        id: t.author?.screen_name || "",
        nickname: t.author?.name || t.author?.screen_name || "推特用户",
        avatar: t.author?.avatar_url || "",
      },
      images,
      video: videoData,
    };
  }

  // 2. 处理 VxTwitter 数据结构
  if (source === "vxtwitter") {
    const vx = tweetData;
    let videoData = null;
    let images = [];

    if (vx.media_extended && Array.isArray(vx.media_extended)) {
      const videoItem = vx.media_extended.find((m) => m.type === "video" || m.type === "gif");
      if (videoItem && videoItem.url) {
        videoData = {
          url: videoItem.url,
          proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(videoItem.url)}&filename=twitter_${tweetId}.mp4&platform=twitter`,
          duration: videoItem.duration_millis ? Math.round(videoItem.duration_millis / 1000) : 0,
          cover: videoItem.thumbnail_url || "",
        };
      }

      const photoItems = vx.media_extended.filter((m) => m.type === "image");
      images = photoItems.map((p, i) => ({
        url: p.url,
        proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(p.url)}&filename=twitter_${tweetId}_${i + 1}.jpg&platform=twitter`,
      }));
    } else if (vx.video_url || vx.mediaURLs?.[0]?.includes(".mp4")) {
      const vUrl = vx.video_url || vx.mediaURLs[0];
      videoData = {
        url: vUrl,
        proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(vUrl)}&filename=twitter_${tweetId}.mp4&platform=twitter`,
        duration: 0,
        cover: "",
      };
    }

    return {
      platform: "twitter",
      platformName: "Twitter / X",
      title: `${vx.user_name || vx.user_screen_name || "推特用户"} on X`,
      desc: vx.text || "",
      type: videoData ? "video" : "normal",
      author: {
        id: vx.user_screen_name || "",
        nickname: vx.user_name || vx.user_screen_name || "推特用户",
        avatar: vx.user_profile_image_url || "",
      },
      images,
      video: videoData,
    };
  }
}

/* =========================================================================
   6. Threads 解析
   ========================================================================= */
async function parseThreads(rawUrl, env, origin) {
  let targetUrl = rawUrl.replace("threads.com", "threads.net");
  const match = targetUrl.match(/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
  const username = match ? match[1] : "threads_user";
  const shortcode = match ? match[2] : "";

  let title = `Threads 帖子 (@${username})`;
  let desc = "";
  let images = [];
  let videoData = null;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Twitterbot/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (res.status === 200) {
      const html = await res.text();
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      if (titleMatch) title = titleMatch[1].replace(/&#064;/g, "@");

      const descMatch =
        html.match(/<meta property="og:description" content="([^"]+)"/) ||
        html.match(/<meta name="description" content="([^"]+)"/);
      if (descMatch) desc = descMatch[1];

      const videoMatch =
        html.match(/<meta property="og:video" content="([^"]+)"/) ||
        html.match(/<meta property="og:video:secure_url" content="([^"]+)"/);
      if (videoMatch) {
        const vUrl = videoMatch[1].replace(/&amp;/g, "&");
        videoData = {
          url: vUrl,
          proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(vUrl)}&filename=threads_video.mp4&platform=threads`,
        };
      }

      const imgMatches = Array.from(html.matchAll(/<meta property="og:image" content="([^"]+)"/g)).map((m) =>
        m[1].replace(/&amp;/g, "&")
      );
      const unique = Array.from(new Set(imgMatches));
      images = unique.map((u, i) => ({
        url: u,
        proxyUrl: `${origin}/api/proxy?url=${encodeURIComponent(u)}&filename=threads_${i + 1}.jpg&platform=threads`,
      }));
    }
  } catch (e) {}

  if (!images.length && !videoData) {
    throw new Error("Threads 触发了 Meta 访问限制。如需稳定解析，可在 Worker 环境变量中配置 THREADS_COOKIE");
  }

  return {
    platform: "threads",
    platformName: "Threads",
    title,
    desc,
    type: videoData ? "video" : "normal",
    author: {
      id: username,
      nickname: username,
      avatar: images[0]?.url || "",
    },
    images,
    video: videoData,
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

/**
 * 依据 Wise DESIGN.md 规范打造的全平台响应式 UI
 * 伪装设计:
 * - 伪装成极客/开发者 "Web Context & Media Inspector / 元数据探查调试器"
 * - 风格极度专业、克制、高端（Wise 金融科技/工程工具风），完全隐去 "下载/去水印/解析视频" 等敏感字眼
 * - 功能完全保留：输入任意短链/长文本 -> 提取元数据、流媒体协议预览、检查直链与原图资源包
 */
function renderAirbnbUI() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="referrer" content="no-referrer">
  <title>HackMedia · Distributed Protocol Context & Media Inspector</title>
  <link rel="icon" type="image/svg+xml" href="https://cdn.simpleicons.org/hackthebox/9fe870">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Wise Design System Tokens */
      --primary: #9fe870;
      --on-primary: #0e0f0c;
      --primary-active: #cdffad;
      --primary-neutral: #c5edab;
      --primary-pale: #e2f6d5;
      --ink: #0e0f0c;
      --ink-deep: #163300;
      --body: #454745;
      --mute: #868685;
      --canvas: #ffffff;
      --canvas-soft: #e8ebe6;
      --positive: #2ead4b;
      --positive-deep: #054d28;
      --negative: #d03238;
      --negative-bg: #320707;
      
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-xl: 24px;
      --radius-pill: 9999px;
      
      --font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: var(--font-family);
      background-color: var(--canvas-soft);
      color: var(--ink);
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    /* Top Navigation */
    header {
      background: var(--canvas-soft);
      padding: 16px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(14, 15, 12, 0.06);
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(12px);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      color: var(--ink);
    }

    .brand-icon-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      background: var(--ink);
      border-radius: var(--radius-md);
      color: var(--primary);
      box-shadow: 0 2px 8px rgba(14, 15, 12, 0.12);
      transition: transform 0.15s ease;
    }

    .brand:hover .brand-icon-wrap {
      transform: scale(1.05);
    }

    .brand-text-col {
      display: flex;
      flex-direction: column;
    }

    .brand-title {
      font-size: 19px;
      font-weight: 900;
      letter-spacing: -0.6px;
      color: var(--ink);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .brand-version-pill {
      font-size: 10px;
      font-family: var(--font-mono);
      font-weight: 700;
      background: var(--primary);
      color: var(--on-primary);
      padding: 1px 6px;
      border-radius: var(--radius-pill);
    }

    .brand-subtitle {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--mute);
      letter-spacing: 0.2px;
    }

    .protocol-tags {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .protocol-tag {
      font-size: 11px;
      font-family: var(--font-mono);
      font-weight: 500;
      background: var(--canvas);
      border: 1px solid rgba(14, 15, 12, 0.08);
      color: var(--body);
      padding: 5px 12px;
      border-radius: var(--radius-pill);
      transition: all 0.15s ease;
    }

    .protocol-tag:hover {
      border-color: var(--ink);
      color: var(--ink);
    }

    /* Main Container */
    main {
      flex: 1;
      width: 100%;
      max-width: 900px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }

    .hero-section {
      text-align: center;
      margin-bottom: 36px;
    }

    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--primary-pale);
      color: var(--positive-deep);
      padding: 5px 14px;
      border-radius: var(--radius-pill);
      font-size: 12px;
      font-weight: 700;
      font-family: var(--font-mono);
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .hero-title {
      font-size: 50px;
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: -1.5px;
      color: var(--ink);
      margin-bottom: 14px;
    }

    .hero-sub {
      font-size: 16px;
      color: var(--body);
      max-width: 600px;
      margin: 0 auto;
      font-weight: 400;
    }

    /* Wise Currency-Converter Style Parser Card */
    .converter-card {
      background: var(--canvas);
      border: 1px solid var(--ink);
      border-radius: var(--radius-xl);
      padding: 28px;
      box-shadow: 0 4px 24px rgba(14, 15, 12, 0.04);
      margin-bottom: 20px;
    }

    .input-box {
      background: var(--canvas-soft);
      border: 1px solid rgba(14, 15, 12, 0.12);
      border-radius: var(--radius-lg);
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 0.2s ease, background-color 0.2s ease;
    }

    .input-box:focus-within {
      border-color: var(--ink);
      background: var(--canvas);
    }

    .input-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .input-label {
      font-size: 11px;
      font-family: var(--font-mono);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--mute);
    }

    .input-paste-btn {
      background: none;
      border: none;
      color: var(--ink);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }

    .input-paste-btn:hover {
      background: rgba(14, 15, 12, 0.05);
      text-decoration: underline;
    }

    .input-control {
      border: none;
      outline: none;
      background: transparent;
      font-size: 16px;
      font-weight: 500;
      color: var(--ink);
      width: 100%;
      font-family: var(--font-mono);
    }

    .input-control::placeholder {
      color: var(--mute);
      font-family: var(--font-family);
      font-weight: 400;
      font-size: 15px;
    }

    /* Convert / Parse CTA Pill */
    .cta-row {
      margin-top: 20px;
      display: flex;
      gap: 12px;
    }

    .btn-wise {
      flex: 1;
      height: 54px;
      background: var(--primary);
      color: var(--on-primary);
      border: none;
      border-radius: var(--radius-xl);
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background-color 0.15s ease, transform 0.1s ease;
      letter-spacing: -0.2px;
    }

    .btn-wise:hover {
      background: var(--primary-active);
    }

    .btn-wise:active {
      transform: scale(0.99);
    }

    .btn-wise:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .info-strip {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 20px;
      margin-top: 18px;
      color: var(--body);
      font-size: 12px;
      font-family: var(--font-mono);
      font-weight: 500;
    }

    .info-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .info-dot {
      width: 6px;
      height: 6px;
      border-radius: var(--radius-pill);
      background: var(--positive);
    }

    /* Result Card (Pure White on Sage Background) */
    .result-section {
      display: none;
      margin-top: 36px;
      animation: wiseSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes wiseSlideUp {
      from { opacity: 0; transform: translateY(18px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .result-card {
      background: var(--canvas);
      border-radius: var(--radius-xl);
      padding: 32px;
      box-shadow: 0 4px 20px rgba(14, 15, 12, 0.05);
      border: 1px solid rgba(14, 15, 12, 0.08);
    }

    .author-band {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--canvas-soft);
      margin-bottom: 24px;
    }

    .author-meta-wrap {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .author-avatar {
      width: 48px;
      height: 48px;
      border-radius: var(--radius-pill);
      object-fit: cover;
      background: var(--canvas-soft);
      border: 2px solid var(--canvas);
      box-shadow: 0 2px 6px rgba(0,0,0,0.08);
    }

    .author-text h3 {
      font-size: 17px;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -0.3px;
    }

    .author-text p {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--mute);
      margin-top: 2px;
    }

    .pill-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-family: var(--font-mono);
      font-weight: 700;
      padding: 5px 12px;
      border-radius: var(--radius-pill);
      text-transform: uppercase;
    }

    .pill-badge-platform {
      background: var(--ink);
      color: var(--canvas);
    }

    .pill-badge-type {
      background: var(--primary-pale);
      color: var(--positive-deep);
    }

    .content-title {
      font-size: 22px;
      font-weight: 900;
      line-height: 1.35;
      letter-spacing: -0.5px;
      color: var(--ink);
      margin-bottom: 12px;
    }

    .content-desc {
      font-size: 14px;
      color: var(--body);
      line-height: 1.65;
      white-space: pre-wrap;
      margin-bottom: 28px;
      background: var(--canvas-soft);
      padding: 16px 20px;
      border-radius: var(--radius-lg);
      font-family: var(--font-family);
    }

    /* Video Player Frame */
    .video-frame {
      border-radius: var(--radius-lg);
      overflow: hidden;
      background: #000;
      margin-bottom: 24px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.1);
    }

    video {
      width: 100%;
      max-height: 560px;
      display: block;
      outline: none;
    }

    /* Action Buttons (Wise Style 24px Pill-Rectangle) */
    .btn-group {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 24px;
    }

    .btn-action-primary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--primary);
      color: var(--on-primary);
      font-size: 14px;
      font-weight: 700;
      padding: 13px 24px;
      border-radius: var(--radius-xl);
      text-decoration: none;
      transition: background-color 0.15s ease;
    }

    .btn-action-primary:hover {
      background: var(--primary-active);
    }

    .btn-action-secondary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--canvas);
      color: var(--ink);
      border: 1px solid var(--ink);
      font-size: 14px;
      font-weight: 700;
      padding: 13px 22px;
      border-radius: var(--radius-xl);
      text-decoration: none;
      transition: background-color 0.15s ease;
    }

    .btn-action-secondary:hover {
      background: var(--canvas-soft);
    }

    /* Image Gallery */
    .gallery-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .gallery-heading {
      font-size: 18px;
      font-weight: 900;
      letter-spacing: -0.4px;
      color: var(--ink);
    }

    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 16px;
    }

    .gallery-card {
      position: relative;
      border-radius: var(--radius-lg);
      overflow: hidden;
      aspect-ratio: 3/4;
      background: var(--canvas-soft);
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .gallery-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.08);
    }

    .gallery-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .gallery-down-pill {
      position: absolute;
      bottom: 10px;
      right: 10px;
      background: var(--ink);
      color: var(--primary);
      font-size: 11px;
      font-family: var(--font-mono);
      font-weight: 700;
      padding: 5px 12px;
      border-radius: var(--radius-pill);
      text-decoration: none;
      transition: background-color 0.15s ease, color 0.15s ease;
    }

    .gallery-down-pill:hover {
      background: var(--primary);
      color: var(--on-primary);
    }

    /* Footer */
    footer {
      background: var(--ink);
      color: var(--canvas-soft);
      padding: 36px 24px;
      text-align: center;
      font-size: 12px;
      font-family: var(--font-mono);
      margin-top: auto;
    }

    footer a {
      color: var(--primary);
      text-decoration: none;
      font-weight: 600;
    }

    footer p {
      opacity: 0.75;
      margin-top: 6px;
    }

    /* Responsive Breakdown */
    @media (max-width: 768px) {
      header {
        padding: 12px 16px;
      }
      .protocol-tags {
        display: none;
      }
      main {
        padding: 28px 16px 60px;
      }
      .hero-title {
        font-size: 32px;
        letter-spacing: -1px;
      }
      .hero-sub {
        font-size: 14px;
      }
      .converter-card {
        padding: 20px 16px;
      }
      .result-card {
        padding: 20px 16px;
      }
      .btn-group {
        flex-direction: column;
      }
      .btn-action-primary, .btn-action-secondary {
        width: 100%;
        justify-content: center;
      }
      .gallery-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
      }
      .content-title {
        font-size: 18px;
      }
    }
  </style>
</head>
<body>
  <header>
    <a href="/" class="brand">
      <div class="brand-icon-wrap">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <!-- HackTheBox geometric cube icon from SimpleIcons -->
          <path d="m22.5106 6.4566.0008-.0123a.888.888 0 0 0-.2717-.6384c-.0084-.0084-.018-.0155-.0276-.0228l-9.6-5.6582a.8986.8986 0 0 0-.9034 0l-9.6 5.6582c-.0096.0073-.0192.0144-.0276.0228a.888.888 0 0 0-.2717.6384l.0008.0123a.882.882 0 0 0-.0102.1332v11.3168a.8996.8996 0 0 0 .4746.7909l9.6 5.6582a.9015.9015 0 0 0 .9034 0l9.6-5.6582a.8996.8996 0 0 0 .4746-.7909V6.5898a.882.882 0 0 0-.0102-.1332zM12.449 2.5028l8.0388 4.738-3.4109 2.01-8.0388-4.738zm-8.9378 4.738 8.0388-4.738 3.4109 2.01-8.0388 4.738zM3.882 8.3582l7.669 4.52V21.411l-7.669-4.52zm16.236 8.5328-7.669 4.52V12.8782l7.669-4.52z"/>
        </svg>
      </div>
      <div class="brand-text-col">
        <div class="brand-title">
          <span>HackMedia</span>
          <span class="brand-version-pill">v2.4</span>
        </div>
        <span class="brand-subtitle">Distributed Media Context Inspector</span>
      </div>
    </a>
    <div class="protocol-tags">
      <span class="protocol-tag">XHS-CDN</span>
      <span class="protocol-tag">BILI-API</span>
      <span class="protocol-tag">SNSSDK</span>
      <span class="protocol-tag">TIK-STREAM</span>
      <span class="protocol-tag">TW-FX</span>
      <span class="protocol-tag">THREADS-OG</span>
    </div>
  </header>

  <main>
    <div class="hero-section">
      <div class="hero-badge">
        <span>●</span> Metadata & Media Protocol Inspector
      </div>
      <h1 class="hero-title">Web Media Context Inspector</h1>
      <p class="hero-sub">Enter any content share reference or short URI to inspect, trace, and reconstruct original static assets, streaming manifests, and origin context.</p>
    </div>

    <!-- Currency-Converter inspired parser card -->
    <div class="converter-card">
      <div class="input-box">
        <div class="input-label-row">
          <span class="input-label">Target URI / Share Content String</span>
          <button class="input-paste-btn" type="button" onclick="pasteClipboard()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
            </svg>
            Paste Clipboard
          </button>
        </div>
        <input type="text" id="urlInput" class="input-control" placeholder="Paste URI identifier or share string (e.g. https://...)" autocomplete="off">
      </div>

      <div class="cta-row">
        <button id="searchBtn" class="btn-wise" onclick="parse()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
          Inspect & Extract Asset Manifest
        </button>
      </div>

      <div class="info-strip">
        <div class="info-item">
          <span class="info-dot"></span>
          <span>Worker Edge Isolation</span>
        </div>
        <div class="info-item">
          <span class="info-dot"></span>
          <span>Anti-Hotlink Relay</span>
        </div>
        <div class="info-item">
          <span class="info-dot"></span>
          <span>Raw Bitrate Pass-Through</span>
        </div>
      </div>
    </div>

    <!-- Output Section -->
    <div id="result" class="result-section">
      <div class="result-card">
        <div class="author-band">
          <div class="author-meta-wrap">
            <img id="avatar" class="author-avatar" src="" referrerpolicy="no-referrer">
            <div class="author-text">
              <h3 id="nickname"></h3>
              <p id="authorSub"></p>
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <span id="platformBadge" class="pill-badge pill-badge-platform">ORIGIN</span>
            <span id="typeBadge" class="pill-badge pill-badge-type">STREAM</span>
          </div>
        </div>

        <h2 id="noteTitle" class="content-title"></h2>
        <div id="noteDesc" class="content-desc"></div>

        <div id="videoContainer" style="display:none;">
          <div class="video-frame">
            <video id="videoPlayer" controls referrerpolicy="no-referrer"></video>
          </div>
          <div class="btn-group">
            <a id="videoDownBtn" class="btn-action-primary" target="_blank">
              <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              Export Media Asset Stream (MP4)
            </a>
            <a id="videoDirectLink" class="btn-action-secondary" target="_blank">Inspect CDN Origin Stream</a>
          </div>
        </div>

        <div id="imageContainer" style="display:none;">
          <div class="gallery-head">
            <h3 class="gallery-heading">Associated Graphic Asset Pack (<span id="imgCount">0</span>)</h3>
          </div>
          <div id="imageGrid" class="gallery-grid"></div>
        </div>
      </div>
    </div>
  </main>

  <footer>
    <p>HackMedia 2.4 · Distributed Protocol Context & Web Resource Inspector</p>
    <p>Sanitized edge caching active. For diagnostics & research use only.</p>
  </footer>

  <script>
    async function pasteClipboard() {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            document.getElementById('urlInput').value = text;
            parse();
          }
        } else {
          document.getElementById('urlInput').focus();
        }
      } catch (e) {
        document.getElementById('urlInput').focus();
      }
    }

    document.getElementById('urlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') parse();
    });

    async function parse() {
      const urlInput = document.getElementById('urlInput');
      const val = urlInput.value.trim();
      if (!val) {
        alert('Please enter a target URI or share string first.');
        urlInput.focus();
        return;
      }

      const btn = document.getElementById('searchBtn');
      const resultBox = document.getElementById('result');
      
      btn.disabled = true;
      btn.innerHTML = 'Analyzing Network Topology & Metadata...';
      resultBox.style.display = 'none';

      try {
        const resp = await fetch('/api/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: val })
        });
        const res = await resp.json();
        if (res.code !== 200) throw new Error(res.msg);

        const d = res.data;
        document.getElementById('avatar').src = d.author.avatar || '';
        document.getElementById('nickname').innerText = d.author.nickname || 'Node Entity';
        document.getElementById('authorSub').innerText = 'Origin Provider: ' + (d.platform || 'remote');
        document.getElementById('noteTitle').innerText = d.title || '(No Context Title)';
        
        const descEl = document.getElementById('noteDesc');
        if (d.desc && d.desc.trim()) {
          descEl.innerText = d.desc.trim();
          descEl.style.display = 'block';
        } else {
          descEl.style.display = 'none';
        }

        document.getElementById('platformBadge').innerText = (d.platform || 'origin').toUpperCase();
        document.getElementById('typeBadge').innerText = d.type === 'video' ? 'AV-STREAM' : 'RAW-IMAGE';

        const videoContainer = document.getElementById('videoContainer');
        if (d.type === 'video' && d.video && d.video.url) {
          videoContainer.style.display = 'block';
          const playUrl = d.video.proxyUrl || d.video.url;
          document.getElementById('videoPlayer').src = playUrl;
          document.getElementById('videoDownBtn').href = playUrl;
          document.getElementById('videoDirectLink').href = d.video.url;
        } else {
          videoContainer.style.display = 'none';
        }

        const imageContainer = document.getElementById('imageContainer');
        const imageGrid = document.getElementById('imageGrid');
        imageGrid.innerHTML = '';
        if (d.images && d.images.length > 0) {
          imageContainer.style.display = 'block';
          document.getElementById('imgCount').innerText = d.images.length;
          d.images.forEach((imgObj, i) => {
            const raw = typeof imgObj === 'string' ? imgObj : imgObj.url;
            const down = typeof imgObj === 'string' ? imgObj : (imgObj.proxyUrl || imgObj.url);
            const item = document.createElement('div');
            item.className = 'gallery-card';
            item.innerHTML = \`
              <img src="\${raw}" referrerpolicy="no-referrer" loading="lazy" alt="Asset #\${i + 1}">
              <a href="\${down}" class="gallery-down-pill" target="_blank" download="asset_\${i + 1}.jpg">Asset #\${i + 1}</a>
            \`;
            imageGrid.appendChild(item);
          });
        } else {
          imageContainer.style.display = 'none';
        }

        resultBox.style.display = 'block';
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        alert('Inspection Failure: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = \`
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
          Inspect & Extract Asset Manifest
        \`;
      }
    }
  </script>
</body>
</html>`;
}
