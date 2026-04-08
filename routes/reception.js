const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const bons = await prisma.bonReception.findMany({
    include: { fournisseur: true, lignes: { include: { article: true } }, controleQualite: true }
  });
  res.render('reception/index', { bons });
});

router.get('/create', async (req, res) => {
  const fournisseurs = await prisma.fournisseur.findMany();
  const articles = await prisma.article.findMany();
  res.render('reception/create', { fournisseurs, articles });
});

router.post('/create', async (req, res) => {
  try {
    const { numero, fournisseurId, articleIds, quantitesCommandees, quantitesRecues } = req.body;
    const lignes = [];
    const ids = Array.isArray(articleIds) ? articleIds : [articleIds];
    const qcmd = Array.isArray(quantitesCommandees) ? quantitesCommandees : [quantitesCommandees];
    const qrec = Array.isArray(quantitesRecues) ? quantitesRecues : [quantitesRecues];
    
    let ecartDetecte = false;
    let surplus = false;
    let manquant = false;
    const ecarts = [];
    
    for (let i = 0; i < ids.length; i++) {
      const qc = parseInt(qcmd[i]);
      const qr = parseInt(qrec[i]);
      const ecart = qr - qc;
      
      if (ecart < 0) { manquant = true; ecartDetecte = true; }
      if (ecart > 0) { surplus = true; ecartDetecte = true; }
      
      const article = await prisma.article.findUnique({ where: { id: parseInt(ids[i]) } });
      if (ecart !== 0) {
        ecarts.push(article.reference + ': commandé ' + qc + ', reçu ' + qr + ' (écart: ' + (ecart > 0 ? '+' : '') + ecart + ')');
      }
      
      lignes.push({
        articleId: parseInt(ids[i]),
        quantiteCommandee: qc,
        quantiteRecue: qr,
        quantiteAcceptee: 0,
        quantiteRefusee: 0,
        statutQualite: 'EN_ATTENTE'
      });
    }
    
    await prisma.bonReception.create({
      data: {
        numero,
        fournisseurId: parseInt(fournisseurId),
        lignes: { create: lignes }
      }
    });

    if (manquant) {
      const fournisseur = await prisma.fournisseur.findUnique({ where: { id: parseInt(fournisseurId) } });
      await prisma.notification.create({
        data: {
          message: `⚠️ Bon ${numero} : ÉCART QUANTITATIF détecté ! ${ecarts.join(', ')}. Fournisseur: ${fournisseur.nom}. Contrôle qualité en attente.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_RECEPTION'
        }
      });
      await prisma.notification.create({
        data: {
          message: `⚠️ Réception partielle - Bon ${numero} : quantités manquantes détectées. ${ecarts.join(', ')}. Fournisseur: ${fournisseur.nom}.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_ENTREPOT'
        }
      });
    } else if (surplus) {
      const fournisseur = await prisma.fournisseur.findUnique({ where: { id: parseInt(fournisseurId) } });
      await prisma.notification.create({
        data: {
          message: `📦 Bon ${numero} : SURPLUS détecté ! ${ecarts.join(', ')}. Fournisseur: ${fournisseur.nom}. Vérifiez et procédez au contrôle qualité.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_RECEPTION'
        }
      });
    } else {
      await prisma.notification.create({
        data: {
          message: `✅ Bon ${numero} : quantités conformes. ${ids.length} article(s). Contrôle qualité en attente.`,
          lien: '/reception',
          destinataireRole: 'RESPONSABLE_RECEPTION'
        }
      });
    }

    res.redirect('/reception');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

router.get('/controle/:id', async (req, res) => {
  const bon = await prisma.bonReception.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } }, fournisseur: true }
  });
  res.render('reception/controle', { bon });
});

router.post('/controle/:id', async (req, res) => {
  const { resultat, commentaire, quantitesAcceptees, actions, motifs, motifAutres } = req.body;
  const motAutres = Array.isArray(motifAutres) ? motifAutres : [motifAutres];
  const bonId = parseInt(req.params.id);
  
  await prisma.controleQualite.create({
    data: { resultat, commentaire, bonReceptionId: bonId }
  });
  
  const bon = await prisma.bonReception.findUnique({
    where: { id: bonId },
    include: { lignes: true, fournisseur: true }
  });
  
  const qas = Array.isArray(quantitesAcceptees) ? quantitesAcceptees : [quantitesAcceptees];
  const acts = Array.isArray(actions) ? actions : [actions];
  const mots = Array.isArray(motifs) ? motifs : [motifs];
  
  const articlesRetour = [];
  const articlesQuarantaine = [];
  const articlesReserve = [];
  
  for (let i = 0; i < bon.lignes.length; i++) {
    const qa = parseInt(qas[i]) || 0;
    const action = acts[i] || 'aucune';
    const qteRefusee = bon.lignes[i].quantiteRecue - qa;
    
    let statut = 'ACCEPTE';
    if (qteRefusee > 0 && action === 'quarantaine') statut = 'QUARANTAINE';
    else if (qteRefusee > 0 && action === 'retour_fournisseur') statut = 'RETOUR';
    else if (qteRefusee > 0 && action === 'accepter_reserve') statut = 'ACCEPTE_RESERVE';
    else if (qa === 0) statut = 'REFUSE';

    const motifFinal = mots[i] === 'autre' ? (motAutres[i] || 'Non spécifié') : (mots[i] || 'Non spécifié');

    await prisma.ligneBonReception.update({
      where: { id: bon.lignes[i].id },
      data: { 
        quantiteAcceptee: qa,
        quantiteRefusee: qteRefusee,
        actionNonConforme: action,
        statutQualite: statut,
        observations: qteRefusee > 0 
          ? (bon.lignes[i].observations ? bon.lignes[i].observations + ' || QUALITE - Action: ' : 'QUALITE - Action: ') + action + ' | Motif: ' + motifFinal + ' | Refusés: ' + qteRefusee 
          : bon.lignes[i].observations || null
      }
    });
    
    if ((resultat === 'conforme' || resultat === 'partiellement_conforme') && qa > 0) {
      await prisma.mouvementStock.create({
        data: {
          type: 'ENTREE',
          quantite: qa,
          articleId: bon.lignes[i].articleId
        }
      });
      
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      const mouvements = await prisma.mouvementStock.findMany({
        where: { articleId: article.id, type: 'ENTREE' }
      });
      const totalQte = mouvements.reduce((sum, m) => sum + m.quantite, 0);
      const newCump = totalQte > 0 ? ((article.coutMoyenPondere * (totalQte - qa)) + (article.prix * qa)) / totalQte : article.prix;
      await prisma.article.update({
        where: { id: article.id },
        data: { coutMoyenPondere: newCump }
      });
    }
    
    if (action === 'accepter_reserve' && qteRefusee > 0) {
      await prisma.mouvementStock.create({
        data: {
          type: 'ENTREE',
          quantite: qteRefusee,
          articleId: bon.lignes[i].articleId
        }
      });
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      articlesReserve.push(article.reference + ' - ' + article.designation + ' (' + qteRefusee + ' avec réserve)');
    }
    
    if (action === 'retour_fournisseur' && qteRefusee > 0) {
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      articlesRetour.push({ article, quantite: qteRefusee });
    }
    
    if (action === 'quarantaine' && qteRefusee > 0) {
      const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
      articlesQuarantaine.push({ article, quantite: qteRefusee });
    }
  }

  if (resultat === 'conforme') {
    await prisma.notification.create({
      data: {
        message: `Bon ${bon.numero} : contrôle qualité conforme ✓. Stock mis à jour. Veuillez affecter les articles.`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else if (resultat === 'partiellement_conforme') {
    let details = '';
    if (articlesRetour.length > 0) details += ' Retour fournisseur: ' + articlesRetour.map(a => a.article.reference + '(' + a.quantite + ')').join(', ') + '.';
    if (articlesQuarantaine.length > 0) details += ' Quarantaine: ' + articlesQuarantaine.map(a => a.article.reference + '(' + a.quantite + ')').join(', ') + '.';
    if (articlesReserve.length > 0) details += ' Acceptés avec réserve: ' + articlesReserve.join(', ') + '.';
    
    await prisma.notification.create({
      data: {
        message: `⚠ Bon ${bon.numero} : partiellement conforme. Stock mis à jour avec les quantités acceptées.${details}`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else {
    let details = '';
    if (articlesRetour.length > 0) details += ' Retour fournisseur prévu.';
    if (articlesQuarantaine.length > 0) details += ' Articles mis en quarantaine.';
    
    await prisma.notification.create({
      data: {
        message: `❌ Bon ${bon.numero} : non conforme. Aucune entrée en stock.${details}`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  if (articlesRetour.length > 0) {
    const listeRetour = articlesRetour.map(a => a.article.reference + ' - ' + a.article.designation + ' (qte: ' + a.quantite + ')').join(', ');
    await prisma.notification.create({
      data: {
        message: `🔄 RETOUR FOURNISSEUR - Bon ${bon.numero} : ${listeRetour}. Fournisseur: ${bon.fournisseur.nom}. Veuillez préparer le bon de retour.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });
    await prisma.notification.create({
      data: {
        message: `🔄 Retour fournisseur prévu pour ${bon.fournisseur.nom} : ${listeRetour}. Bon ${bon.numero}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  if (articlesQuarantaine.length > 0) {
    const listeQuarantaine = articlesQuarantaine.map(a => a.article.reference + ' - ' + a.article.designation + ' (qte: ' + a.quantite + ')').join(', ');
    await prisma.notification.create({
      data: {
        message: `🟡 QUARANTAINE - Bon ${bon.numero} : ${listeQuarantaine}. Articles bloqués en attente de décision.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  for (let i = 0; i < bon.lignes.length; i++) {
    const qa = parseInt(qas[i]) || 0;
    if (qa > 0) {
      const backorders = await prisma.commande.findMany({
        where: { statut: 'BACKORDER' },
        include: { lignes: { where: { articleId: bon.lignes[i].articleId } } }
      });
      for (const bo of backorders) {
        if (bo.lignes.length > 0) {
          const article = await prisma.article.findUnique({ where: { id: bon.lignes[i].articleId } });
          await prisma.notification.create({
            data: {
              message: `🔔 Réapprovisionnement : ${article.reference} - ${article.designation} est de nouveau en stock ! Le backorder ${bo.numero} peut être traité.`,
              lien: '/commandes',
              destinataireRole: 'RESPONSABLE_COMMANDE'
            }
          });
        }
      }
    }
  }

  res.redirect('/reception');
});

router.get('/fournisseurs', async (req, res) => {
  const fournisseurs = await prisma.fournisseur.findMany();
  res.render('reception/fournisseurs', { fournisseurs });
});

router.post('/fournisseurs/create', async (req, res) => {
  const { nom, adresse, telephone, email } = req.body;
  await prisma.fournisseur.create({ data: { nom, adresse, telephone, email } });
  res.redirect('/reception/fournisseurs');
});

router.get('/pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const bon = await prisma.bonReception.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { 
      fournisseur: true, 
      lignes: { include: { article: true } },
      controleQualite: true 
    }
  });

  if (!bon) return res.status(404).send('Bon introuvable');

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=BR-' + bon.numero + '.pdf');
  doc.pipe(res);

  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Bon de Reception', { align: 'center' });
  doc.moveDown();

  doc.fontSize(10).font('Helvetica');
  doc.text('Numero: ' + bon.numero);
  doc.text('Date: ' + bon.date.toLocaleDateString('fr-FR'));
  doc.text('Fournisseur: ' + bon.fournisseur.nom);
  doc.text('Adresse: ' + bon.fournisseur.adresse);
  doc.text('Telephone: ' + bon.fournisseur.telephone);
  doc.moveDown();

  doc.font('Helvetica-Bold').fontSize(11);
  const tableTop = doc.y;
  doc.text('Reference', 50, tableTop, { width: 80 });
  doc.text('Designation', 130, tableTop, { width: 150 });
  doc.text('Qte Cmd', 280, tableTop, { width: 60 });
  doc.text('Qte Recue', 340, tableTop, { width: 70 });
  doc.text('Qte Acceptee', 410, tableTop, { width: 80 });
  
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(10);
  let y = tableTop + 25;
  
  bon.lignes.forEach(ligne => {
    doc.text(ligne.article.reference, 50, y, { width: 80 });
    doc.text(ligne.article.designation, 130, y, { width: 150 });
    doc.text(String(ligne.quantiteCommandee), 280, y, { width: 60 });
    doc.text(String(ligne.quantiteRecue), 340, y, { width: 70 });
    doc.text(String(ligne.quantiteAcceptee), 410, y, { width: 80 });
    y += 20;
  });

  if (bon.controleQualite) {
    doc.moveDown(2);
    y = doc.y;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    doc.moveDown();
    doc.font('Helvetica-Bold').fontSize(11).text('Controle Qualite');
    doc.font('Helvetica').fontSize(10);
    doc.text('Resultat: ' + bon.controleQualite.resultat);
    doc.text('Date: ' + bon.controleQualite.dateControle.toLocaleDateString('fr-FR'));
    if (bon.controleQualite.commentaire) {
      doc.text('Commentaire: ' + bon.controleQualite.commentaire);
    }
  }

  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(9).text('Document genere automatiquement par WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

// Page quarantaine
router.get('/quarantaine', async (req, res) => {
  const lignesQuarantaine = await prisma.ligneBonReception.findMany({
    where: { statutQualite: 'QUARANTAINE' },
    include: { 
      article: true, 
      bonReception: { include: { fournisseur: true } } 
    }
  });
  res.render('reception/quarantaine', { lignes: lignesQuarantaine });
});

// Décision quarantaine
router.post('/quarantaine/decision/:id', async (req, res) => {
  const ligneId = parseInt(req.params.id);
  const { decision, commentaire } = req.body;
  
  const ligne = await prisma.ligneBonReception.findUnique({
    where: { id: ligneId },
    include: { article: true, bonReception: { include: { fournisseur: true } } }
  });

  if (decision === 'accepter') {
    await prisma.mouvementStock.create({
      data: {
        type: 'ENTREE',
        quantite: ligne.quantiteRefusee,
        articleId: ligne.articleId
      }
    });

    const article = await prisma.article.findUnique({ where: { id: ligne.articleId } });
    const mouvements = await prisma.mouvementStock.findMany({
      where: { articleId: article.id, type: 'ENTREE' }
    });
    const totalQte = mouvements.reduce((sum, m) => sum + m.quantite, 0);
    const newCump = totalQte > 0 ? ((article.coutMoyenPondere * (totalQte - ligne.quantiteRefusee)) + (article.prix * ligne.quantiteRefusee)) / totalQte : article.prix;
    await prisma.article.update({
      where: { id: article.id },
      data: { coutMoyenPondere: newCump }
    });

    await prisma.ligneBonReception.update({
      where: { id: ligneId },
      data: { 
        statutQualite: 'ACCEPTE_APRES_QUARANTAINE',
        observations: (ligne.observations || '') + ' | Quarantaine: ACCEPTÉ - ' + (commentaire || '')
      }
    });

    await prisma.notification.create({
      data: {
        message: `✅ Quarantaine - ${ligne.article.reference} (${ligne.quantiteRefusee} unités) : ACCEPTÉ après inspection. Stock mis à jour.`,
        lien: '/emplacements/affecter',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });

  } else if (decision === 'retour') {
    await prisma.ligneBonReception.update({
      where: { id: ligneId },
      data: { 
        statutQualite: 'RETOUR_APRES_QUARANTAINE',
        observations: (ligne.observations || '') + ' | Quarantaine: RETOUR FOURNISSEUR - ' + (commentaire || '')
      }
    });

    await prisma.notification.create({
      data: {
        message: `🔄 Quarantaine - ${ligne.article.reference} (${ligne.quantiteRefusee} unités) : RETOUR FOURNISSEUR. Fournisseur: ${ligne.bonReception.fournisseur.nom}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });
    await prisma.notification.create({
      data: {
        message: `🔄 Retour fournisseur après quarantaine : ${ligne.article.reference} (${ligne.quantiteRefusee}) → ${ligne.bonReception.fournisseur.nom}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });

  } else if (decision === 'rejeter') {
    await prisma.ligneBonReception.update({
      where: { id: ligneId },
      data: { 
        statutQualite: 'REJETE',
        observations: (ligne.observations || '') + ' | Quarantaine: REJETÉ/DÉTRUIT - ' + (commentaire || '')
      }
    });

    await prisma.notification.create({
      data: {
        message: `❌ Quarantaine - ${ligne.article.reference} (${ligne.quantiteRefusee} unités) : REJETÉ. Motif: ${commentaire || 'Non spécifié'}.`,
        lien: '/reception/quarantaine',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  res.redirect('/reception/quarantaine');
});

// Décision écart quantitatif
router.post('/decision-ecart/:id', async (req, res) => {
  const bonId = parseInt(req.params.id);
  const { decision } = req.body;
  
  const bon = await prisma.bonReception.findUnique({
    where: { id: bonId },
    include: { lignes: { include: { article: true } }, fournisseur: true }
  });

  if (decision === 'accepter_surplus') {
    for (const ligne of bon.lignes) {
      if (ligne.quantiteRecue > ligne.quantiteCommandee) {
        await prisma.ligneBonReception.update({
          where: { id: ligne.id },
          data: { 
            observations: 'Surplus de ' + (ligne.quantiteRecue - ligne.quantiteCommandee) + ' accepté - Fournisseur notifié'
          }
        });
      }
    }

    const surplusDetails = bon.lignes
      .filter(l => l.quantiteRecue > l.quantiteCommandee)
      .map(l => l.article.reference + ' (+' + (l.quantiteRecue - l.quantiteCommandee) + ')');

    await prisma.notification.create({
      data: {
        message: `✅ Bon ${bon.numero} : surplus ACCEPTÉ. Articles: ${surplusDetails.join(', ')}. Fournisseur ${bon.fournisseur.nom} notifié pour ajustement facture. Procédez au contrôle qualité.`,
        lien: '/reception/controle/' + bonId,
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });

    await prisma.notification.create({
      data: {
        message: `📦 Bon ${bon.numero} : surplus accepté. ${surplusDetails.join(', ')}. Fournisseur ${bon.fournisseur.nom} notifié.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });

    return res.redirect('/reception');

  } else if (decision === 'refuser_surplus') {
    for (const ligne of bon.lignes) {
      if (ligne.quantiteRecue > ligne.quantiteCommandee) {
        await prisma.ligneBonReception.update({
          where: { id: ligne.id },
          data: { 
            quantiteRecue: ligne.quantiteCommandee,
            observations: 'Surplus de ' + (ligne.quantiteRecue - ligne.quantiteCommandee) + ' refusé et retourné au fournisseur'
          }
        });
      }
    }

    const surplus = bon.lignes
      .filter(l => l.quantiteRecue > l.quantiteCommandee)
      .map(l => l.article.reference + ' (surplus: ' + (l.quantiteRecue - l.quantiteCommandee) + ')');

    await prisma.notification.create({
      data: {
        message: `🔄 Bon ${bon.numero} : surplus refusé et retourné à ${bon.fournisseur.nom}. ${surplus.join(', ')}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_RECEPTION'
      }
    });
    await prisma.notification.create({
      data: {
        message: `🔄 Surplus retourné à ${bon.fournisseur.nom} pour Bon ${bon.numero}. ${surplus.join(', ')}.`,
        lien: '/reception',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  return res.redirect('/reception');
});

// Bon de retour fournisseur PDF
router.get('/bon-retour/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const bon = await prisma.bonReception.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { 
      fournisseur: true, 
      lignes: { include: { article: true } },
      controleQualite: true 
    }
  });

  if (!bon) return res.status(404).send('Bon introuvable');

  // Collecter les articles à retourner
  const articlesRetour = [];
  bon.lignes.forEach(ligne => {
    // Retour surplus (observations contient "Surplus" + "refusé")
    if (ligne.observations && ligne.observations.includes('Surplus') && ligne.observations.includes('refus')) {
      const match = ligne.observations.match(/Surplus de (\d+)/);
      if (match) {
        articlesRetour.push({
          reference: ligne.article.reference,
          designation: ligne.article.designation,
          quantite: parseInt(match[1]),
          motif: 'Surplus refusé - Écart quantitatif',
          type: 'SURPLUS',
          prix: ligne.article.prix
        });
      }
    }
    
    // Retour qualité (actionNonConforme = retour_fournisseur)
    if (ligne.actionNonConforme === 'retour_fournisseur' && ligne.quantiteRefusee > 0) {
      let motif = 'Non conforme';
      if (ligne.observations) {
        const motifMatchQualite = ligne.observations.match(/QUALITE.*Motif: ([^|]+)/);
        const motifMatchSimple = ligne.observations.match(/Motif: ([^|]+)/);
        if (motifMatchQualite) motif = motifMatchQualite[1].trim();
        else if (motifMatchSimple) motif = motifMatchSimple[1].trim();
      }
      articlesRetour.push({
        reference: ligne.article.reference,
        designation: ligne.article.designation,
        quantite: ligne.quantiteRefusee,
        motif: 'Qualité - ' + motif,
        type: 'QUALITE',
        prix: ligne.article.prix
      });
    }
    
    // Retour après quarantaine
    if (ligne.statutQualite === 'RETOUR_APRES_QUARANTAINE' && ligne.quantiteRefusee > 0) {
      let motif = 'Rejeté après quarantaine';
      if (ligne.observations) {
        const motifMatch = ligne.observations.match(/Motif: ([^|]+)/);
        if (motifMatch) motif = 'Quarantaine - ' + motifMatch[1].trim();
      }
      const dejaAjoute = articlesRetour.some(a => a.reference === ligne.article.reference && a.type === 'QUALITE');
      if (!dejaAjoute) {
        articlesRetour.push({
          reference: ligne.article.reference,
          designation: ligne.article.designation,
          quantite: ligne.quantiteRefusee,
          motif: motif,
          type: 'QUARANTAINE',
          prix: ligne.article.prix
        });
      }
    }
  });

  if (articlesRetour.length === 0) return res.status(404).send('Aucun article à retourner pour ce bon');

  const doc = new PDFDocument({ margin: 50 });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=RETOUR-' + bon.numero + '.pdf');
  doc.pipe(res);

  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('BON DE RETOUR FOURNISSEUR', { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Reference:', 50, infoY);
  doc.font('Helvetica');
  doc.text('Bon de reception: ' + bon.numero, 50, infoY + 15);
  doc.text('Date reception: ' + bon.date.toLocaleDateString('fr-FR'), 50, infoY + 30);
  doc.text('Date retour: ' + new Date().toLocaleDateString('fr-FR'), 50, infoY + 45);
  if (bon.controleQualite) {
    doc.text('Resultat controle: ' + bon.controleQualite.resultat, 50, infoY + 60);
  }

  doc.font('Helvetica-Bold').text('Fournisseur:', 350, infoY);
  doc.font('Helvetica');
  doc.text(bon.fournisseur.nom, 350, infoY + 15);
  doc.text(bon.fournisseur.adresse, 350, infoY + 30);
  doc.text('Tel: ' + bon.fournisseur.telephone, 350, infoY + 45);
  doc.text('Email: ' + bon.fournisseur.email, 350, infoY + 60);

  doc.y = infoY + 90;
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Reference', 50, tableTop, { width: 70 });
  doc.text('Designation', 120, tableTop, { width: 130 });
  doc.text('Qte', 250, tableTop, { width: 30 });
  doc.text('Prix unit.', 280, tableTop, { width: 60 });
  doc.text('Type', 340, tableTop, { width: 60 });
  doc.text('Motif', 400, tableTop, { width: 150 });
  
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(8);
  let y2 = tableTop + 25;
  let totalRetour = 0;
  
  articlesRetour.forEach(a => {
    const total = a.quantite * a.prix;
    totalRetour += total;
    doc.text(a.reference, 50, y2, { width: 70 });
    doc.text(a.designation, 120, y2, { width: 130 });
    doc.text(String(a.quantite), 250, y2, { width: 30 });
    doc.text(a.prix.toFixed(2) + ' DH', 280, y2, { width: 60 });
    doc.text(a.type, 340, y2, { width: 60 });
    doc.text(a.motif, 400, y2, { width: 150 });
    y2 += 25;
  });

  doc.moveTo(50, y2 + 5).lineTo(550, y2 + 5).stroke();
  y2 += 15;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total articles retournes: ' + articlesRetour.reduce((s, a) => s + a.quantite, 0), 50, y2);
  doc.text('Valeur totale: ' + totalRetour.toFixed(2) + ' DH', 300, y2);

  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(10).text('Action demandee:');
  doc.font('Helvetica').fontSize(9);
  doc.text('Nous vous retournons les articles ci-dessus pour les motifs indiques.');
  doc.text('Merci de proceder au remplacement ou au remboursement dans les meilleurs delais.');

  doc.moveDown(2);
  const sigY = doc.y;
  doc.text('Expediteur (WMS ENSIAS):', 50, sigY);
  doc.text('Fournisseur:', 350, sigY);
  doc.moveTo(50, sigY + 35).lineTo(200, sigY + 35).stroke();
  doc.moveTo(350, sigY + 35).lineTo(500, sigY + 35).stroke();
  doc.text('Date: ________________', 50, sigY + 45);
  doc.text('Date: ________________', 350, sigY + 45);

  doc.moveDown(4);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(8).text('WMS ENSIAS - Bon de retour genere automatiquement le ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

module.exports = router;