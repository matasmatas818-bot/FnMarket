// ticket.js – Pilnai lietuviška ir optimizuota Ticket sistema

import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import { buildStandardLogEmbed, formatLogLine } from '../utils/logging/logEmbeds.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData, deleteTicketData, getOpenTicketCountForUser, incrementTicketCounter } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { createEmbed, errorEmbed } from '../utils/embeds.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { ensureTypedServiceError, wrapServiceBoundary } from '../utils/serviceErrorBoundary.js';

// Konstanta violetinei temai
const VIOLET_COLOR = '#8A2BE2';
const TICKET_DELETE_DELAY_MS = 3000;
const TICKET_DELETE_DELAY_SECONDS = Math.floor(TICKET_DELETE_DELAY_MS / 1000);
const TICKET_SERVICE = 'ticketService';

// Prioritetų mapinimas lietuviškai
const PRIORITY_MAP = {
  low: { label: 'Žemas', emoji: '🔵', color: '#3498db' },
  medium: { label: 'Vidutinis', emoji: '🟡', color: '#f1c40f' },
  high: { label: 'Aukštas', emoji: '🔴', color: '#e74c3c' },
  none: { label: 'Nenurodytas', emoji: '⚪', color: VIOLET_COLOR }
};

function ticketUserError(message, userMessage, type = ErrorTypes.VALIDATION, context = {}) {
  throw createError(message, type, userMessage, { service: TICKET_SERVICE, ...context });
}

function requireTicket(ticketData, channel) {
  if (!ticketData) {
    ticketUserError(
      'Ne bilieto kanalas',
      'Šis kanalas nėra bilieto kanalas.',
      ErrorTypes.VALIDATION,
      { channelId: channel?.id, guildId: channel?.guild?.id }
    );
  }
  return ticketData;
}

function rethrowTicketError(error, operation, userMessage, context = {}) {
  throw ensureTypedServiceError(error, {
    service: TICKET_SERVICE,
    operation,
    message: `Bilieto operacija nepavyko: ${operation}`,
    userMessage,
    context,
  });
}

// Bilieto valdymo mygtukų eilutė
function buildTicketControlRow({ claimedBy = null } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel(claimedBy ? 'Priskirta' : 'Prisiimti')
      .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setEmoji('🙋')
      .setDisabled(!!claimedBy),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Uždaryti')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
}

// Bilieto sukūrimas
export async function createTicket(guild, member, categoryId, reason = 'Priežastis nenurodyta', priority = 'none') {
  try {
    const config = await getGuildConfig(guild.client, guild.id);
    const ticketConfig = config.tickets || {};
    
    const maxTicketsPerUser = config.maxTicketsPerUser ?? 3;
    const currentTicketCount = await getOpenTicketCountForUser(guild.id, member.id);
    if (currentTicketCount >= maxTicketsPerUser) {
      ticketUserError(
        `Pasiektas maksimalus bilietų limitas ${member.id}`,
        `Jūs jau turite maksimalų leistiną atvirų bilietų skaičių (${maxTicketsPerUser}). Prašome uždaryti esamus bilietus prieš kuriant naują.`,
        ErrorTypes.VALIDATION,
        { guildId: guild.id, userId: member.id, operation: 'createTicket' }
      );
    }
    
    let category = categoryId ?
      guild.channels.cache.get(categoryId) :
      guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('bilietai'));

    if (!category && !categoryId) {
      category = await guild.channels.create({
        name: '🎫 Bilietai',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }
    
    const ticketNumber = await incrementTicketCounter(guild.id);
    let channelName = `bilietas-${ticketNumber}`;

    if (priority !== 'none' && PRIORITY_MAP[priority]) {
      channelName = `${PRIORITY_MAP[priority].emoji} ${channelName}`;
    }
    
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        ...(config.ticketStaffRoleId ? [{
          id: config.ticketStaffRoleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        }] : []),
      ],
    });

    const ticketData = {
      id: channel.id,
      userId: member.id,
      guildId: guild.id,
      createdAt: new Date().toISOString(),
      status: 'open',
      claimedBy: null,
      priority: priority || 'none',
      reason,
    };
    
    await saveTicketData(guild.id, channel.id, ticketData);
    
    const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;
    
    const embed = createEmbed({
      title: `🎫 Bilietas #${ticketNumber}`,
      description: `Sveiki, ${member.toString()}! Dėkojame, kad susisiekėte su pagalba.\n\n**Priežastis:** ${reason}\n**Prioritetas:** ${priorityInfo.emoji} ${priorityInfo.label}`,
      color: VIOLET_COLOR,
      fields: [
        { name: 'Būsena', value: '🟢 Atidarytas', inline: true },
        { name: 'Priskirtas', value: 'Nepriskirtas', inline: true },
        { name: 'Sukurta', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      ],
    });
    
    const row = buildTicketControlRow();
    
    // Prioritetų mygtukai
    const priorityRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_priority:low').setLabel('Žemas').setStyle(ButtonStyle.Secondary).setEmoji('🔵'),
      new ButtonBuilder().setCustomId('ticket_priority:medium').setLabel('Vidutinis').setStyle(ButtonStyle.Secondary).setEmoji('🟡'),
      new ButtonBuilder().setCustomId('ticket_priority:high').setLabel('Aukštas').setStyle(ButtonStyle.Danger).setEmoji('🔴')
    );
    
    const staffMention = config.ticketStaffRoleId ? ` <@&${config.ticketStaffRoleId}>` : '';
    
    const ticketMessage = await channel.send({ 
      content: `${member.toString()}${staffMention}`,
      embeds: [embed],
      components: [row, priorityRow] 
    });

    await ticketMessage.pin().catch(() => {});
    
    await logTicketEvent({
      client: guild.client,
      guildId: guild.id,
      event: {
        type: 'open',
        ticketId: channel.id,
        ticketNumber,
        userId: member.id,
        executorId: member.id,
        reason,
        priority: priority || 'none'
      }
    });

    return { channel, ticketData };
    
  } catch (error) {
    rethrowTicketError(error, 'createTicket', 'Nepavyko sukurti bilieto. Bandykite dar kartą vėliau.', { guildId: guild?.id, userId: member?.id });
  }
}

// Bilieto uždarymas ir Pagalbos Įvertinimo siuntimas
export async function closeTicket(channel, closer, reason = 'Priežastis nenurodyta') {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    ticketData.status = 'closed';
    ticketData.closedBy = closer.id;
    ticketData.closedAt = new Date().toISOString();
    ticketData.closeReason = reason;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    // Naikinti vartotojo teises rašyti
    try {
      await channel.permissionOverwrites.edit(ticketData.userId, { SendMessages: false, ViewChannel: true });
    } catch (err) {
      logger.warn(`Nepavyko pakeisti teisių: ${err.message}`);
    }

    // ⭐ Įvertinimo siuntimas į AŽ
    try {
      const ticketCreator = await channel.client.users.fetch(ticketData.userId).catch(() => null);
      if (ticketCreator) {
        const feedbackEmbed = createEmbed({
          title: '⭐ Kaip vertinate suteiktą pagalbą?',
          description: `Jūsų bilietas **${channel.name}** buvo uždarytas.\n\n**Uždarė:** ${closer.tag}\n**Priežastis:** ${reason}\n\nPrašome įvertinti mūsų aptarnavimo kokybę!`,
          color: VIOLET_COLOR,
        });

        const base = `ticket_feedback:${channel.guild.id}:${channel.id}`;
        const starsRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${base}:1`).setLabel('1 ⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${base}:2`).setLabel('2 ⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${base}:3`).setLabel('3 ⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${base}:4`).setLabel('4 ⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${base}:5`).setLabel('5 ⭐').setStyle(ButtonStyle.Success),
        );

        await ticketCreator.send({ embeds: [feedbackEmbed], components: [starsRow] }).catch(() => {});
      }
    } catch (err) {
      logger.warn(`Nepavyko išsiųsti įvertinimo žinutės: ${err.message}`);
    }

    const closeEmbed = createEmbed({
      title: '🔒 Bilietas Uždarytas',
      description: `Bilietą uždarė: ${closer}\n**Priežastis:** ${reason}`,
      color: '#e74c3c',
    });

    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_reopen').setLabel('Atidaryti iš naujo').setStyle(ButtonStyle.Success).setEmoji('🔓'),
      new ButtonBuilder().setCustomId('ticket_delete').setLabel('Ištrinti bilietą').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
    );

    await channel.send({ embeds: [closeEmbed], components: [controlRow] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: { type: 'close', ticketId: channel.id, userId: ticketData.userId, executorId: closer.id, reason }
    });

    return ticketData;
  } catch (error) {
    rethrowTicketError(error, 'closeTicket', 'Nepavyko uždaryti bilieto.', { channelId: channel?.id });
  }
}

// Priskirti bilietą (Claim)
export async function claimTicket(channel, claimer) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    if (ticketData.claimedBy) {
      ticketUserError('Jau priskirta', `Šis bilietas jau priskirtas <@${ticketData.claimedBy}>`);
    }

    ticketData.claimedBy = claimer.id;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const claimEmbed = createEmbed({
      title: '🙋 Bilietas Priskirtas',
      description: `Bilietą prisiėmė ${claimer}!`,
      color: VIOLET_COLOR,
    });

    const unclaimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_unclaim').setLabel('Atšaukti priskyrimą').setStyle(ButtonStyle.Secondary).setEmoji('🔓')
    );

    await channel.send({ embeds: [claimEmbed], components: [unclaimRow] });
    return ticketData;
  } catch (error) {
    rethrowTicketError(error, 'claimTicket', 'Nepavyko prisiimti bilieto.');
  }
}

// Atšaukti priskyrimą (Unclaim)
export async function unclaimTicket(channel, unclaimer) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    ticketData.claimedBy = null;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const unclaimEmbed = createEmbed({
      title: '🔓 Priskyrimas Atšauktas',
      description: `${unclaimer} atšaukė bilieto priskyrimą. Bilietas vėl laisvas!`,
      color: '#f39c12',
    });

    await channel.send({ embeds: [unclaimEmbed] });
    return ticketData;
  } catch (error) {
    rethrowTicketError(error, 'unclaimTicket', 'Nepavyko atšaukti priskyrimo.');
  }
}

// Pridėti narį prie bilieto
export async function addUserToTicket(channel, memberToAdd, executor) {
  try {
    await channel.permissionOverwrites.edit(memberToAdd.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    const embed = createEmbed({
      title: '👥 Narys Pridėtas',
      description: `${executor} pridėjo ${memberToAdd.toString()} prie šio bilieto.`,
      color: VIOLET_COLOR
    });

    await channel.send({ embeds: [embed] });
  } catch (error) {
    rethrowTicketError(error, 'addUserToTicket', 'Nepavyko pridėti nario prie bilieto.');
  }
}

// Pašalinti narį iš bilieto
export async function removeUserFromTicket(channel, memberToRemove, executor) {
  try {
    await channel.permissionOverwrites.delete(memberToRemove.id);

    const embed = createEmbed({
      title: '👥 Narys Pašalintas',
      description: `${executor} pašalino ${memberToRemove.toString()} iš šio bilieto.`,
      color: '#e74c3c'
    });

    await channel.send({ embeds: [embed] });
  } catch (error) {
    rethrowTicketError(error, 'removeUserFromTicket', 'Nepavyko pašalinti nario.');
  }
}

// 📜 Modernus Violetinis HTML Transcript Generavimas
async function generateTranscript(channel) {
  try {
    const messages = [];
    let before = undefined;
    let batch;
    do {
      batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      before = batch.last()?.id;
    } while (batch.size === 100);

    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const rows = messages.map((msg) => {
      const ts = new Date(msg.createdTimestamp).toLocaleString('lt-LT');
      const author = msg.author?.tag ?? 'Nezinomas';
      const content = msg.content || (msg.embeds.length ? '[Embed pranešimas]' : '[Failas]');
      return `<tr><td class="ts">${ts}</td><td class="author">${author}</td><td class="msg">${content}</td></tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="lt">
<head>
<meta charset="UTF-8">
<title>Išrašas – #${channel.name}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
  h1 { color: #8A2BE2; border-bottom: 2px solid #8A2BE2; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { background: #16213e; color: #8A2BE2; padding: 12px; text-align: left; }
  td { padding: 10px; border-bottom: 1px solid #0f3460; }
  .ts { color: #888; width: 180px; font-size: 0.85em; }
  .author { color: #e94560; font-weight: bold; width: 200px; }
  .msg { color: #dcdde1; }
</style>
</head>
<body>
<h1>📜 Bilieto Išrašas: #${channel.name}</h1>
<p>Išsaugota žinučių: ${messages.length}</p>
<table>
<thead><tr><th>Laikas</th><th>Autorius</th><th>Žinutė</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body>
</html>`;

    return new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `israsas-${channel.id}.html` });
  } catch (error) {
    logger.error('Nepavyko sukurti transcript:', error);
    return null;
  }
}

// Bilieto Ištrynimas ir Išrašo Siuntimas
export async function deleteTicket(channel, deleter) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    const deleteEmbed = createEmbed({
      title: '🗑️ Bilietas Trinamas',
      description: `Šis bilietas bus visam laikui ištrintas už ${TICKET_DELETE_DELAY_SECONDS} sek.`,
      color: '#e74c3c',
    });
    await channel.send({ embeds: [deleteEmbed] });

    setTimeout(async () => {
      try {
        const attachment = await generateTranscript(channel);
        const guildConfig = await getGuildConfig(channel.client, channel.guild.id);
        
        if (attachment && guildConfig.ticketTranscriptChannelId) {
          const logChannel = await channel.client.channels.fetch(guildConfig.ticketTranscriptChannelId).catch(() => null);
          if (logChannel) {
            const logEmbed = buildStandardLogEmbed({
              color: 0x8A2BE2,
              title: '📜 Bilieto Išrašas (Transcript)',
              description: `**Bilietas:** #${channel.name}\n**Ištrynė:** ${deleter.tag}`,
              timestamp: true,
            });
            await logChannel.send({ embeds: [logEmbed], files: [attachment] });
          }
        }
        await channel.delete();
      } catch (err) {
        logger.error('Klaida trinant kanalą:', err);
      }
    }, TICKET_DELETE_DELAY_MS);

    return ticketData;
  } catch (error) {
    rethrowTicketError(error, 'deleteTicket', 'Nepavyko ištrinti bilieto.');
  }
}

// Prioriteto Atnaujinimas
export async function updateTicketPriority(channel, priority, updater) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    const priorityInfo = PRIORITY_MAP[priority];
    if (!priorityInfo) ticketUserError('Neteisingas prioritetas', 'Pasirinktas neteisingas prioritetas.');

    ticketData.priority = priority;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const embed = createEmbed({
      title: '⚡ Prioritetas Atnaujintas',
      description: `Naujas prioritetas: **${priorityInfo.emoji} ${priorityInfo.label}**\nAtnaujino: ${updater}`,
      color: priorityInfo.color
    });

    await channel.send({ embeds: [embed] });
    return ticketData;
  } catch (error) {
    rethrowTicketError(error, 'updateTicketPriority', 'Nepavyko atnaujinti prioriteto.');
  }
}
